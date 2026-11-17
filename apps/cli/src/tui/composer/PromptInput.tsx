/** Claude 风格输入框：底部边框、宽字符光标、历史浏览、Enter 提交与多行换行。 */
import {
  Box,
  type DOMElement,
  Text,
  useApp,
  useBoxMetrics,
  useInput,
  usePaste,
  useWindowSize,
} from "ink";
import { useEffect, useRef, useState } from "react";
import type { ImageAttachment } from "../../image/attachment";
import { imagePathsFromText } from "../../image/path";
import type { ImageAttachmentReader } from "../../image/ports";
import { POINTER, TUI_THEME } from "../chrome/theme";
import { CommandPalette } from "../commands/CommandPalette";
import { completeTuiCommand } from "../commands/catalog";
import { AttachmentBar } from "./AttachmentBar";
import {
  endOfLineOffset,
  inputLayoutColumns,
  inputVisualLineCount,
  moveCursorVertically,
  nextGraphemeOffset,
  previousGraphemeOffset,
  previousWordOffset,
  startOfLineOffset,
} from "./inputLayout";
import { deleteSelection, selectedText, selectionRange } from "./selection";
import { TextInput } from "./TextInput";
import { usePromptAttachments } from "./usePromptAttachments";
import { useTuiCommandHints } from "./useTuiCommandHints";

const CONTROL_HINT = "Enter 发送 · Shift+Enter 或 \\ + Enter 换行 · Esc 取消 · Ctrl-C 两次退出";
const EXIT_ARM_MS = 2_000;
const MIN_INPUT_LINES = 3;
const MAX_INPUT_LINES = 8;
const PROMPT_CHROME_COLUMNS = 4;

interface Draft {
  readonly value: string;
  readonly cursor: number;
  readonly anchor: number | null;
}

export function PromptInput({
  busy,
  onSubmit,
  selectionActive = false,
  idleHint,
  secret = false,
  secretMask,
  allowEmptySubmit = false,
  active = true,
  commandsEnabled = true,
  historyEnabled = true,
  showHints = true,
  showBorder = true,
  showPointer = true,
  marginTop = 1,
  exitOnCtrlC = true,
  initialValue = "",
  columns: columnsOverride,
  maxVisibleLines: maxVisibleLinesOverride,
  onEscape,
  onToggleSecret,
  onCommandPaletteChange,
  onCopyText,
  imageReader,
  onPasteError,
}: {
  busy: boolean;
  onSubmit: (text: string, images?: readonly ImageAttachment[]) => void;
  selectionActive?: boolean;
  idleHint?: string;
  secret?: boolean;
  secretMask?: (value: string) => string;
  allowEmptySubmit?: boolean;
  active?: boolean;
  commandsEnabled?: boolean;
  historyEnabled?: boolean;
  showHints?: boolean;
  showBorder?: boolean;
  showPointer?: boolean;
  marginTop?: number;
  exitOnCtrlC?: boolean;
  initialValue?: string;
  columns?: number;
  maxVisibleLines?: number;
  onEscape?: () => void;
  onToggleSecret?: () => void;
  onCommandPaletteChange?: (open: boolean) => void;
  onCopyText?: (text: string) => void;
  imageReader?: ImageAttachmentReader;
  onPasteError?: (message: string) => void;
}) {
  const { exit } = useApp();
  const { columns: windowColumns, rows } = useWindowSize();
  const inputRef = useRef<DOMElement | null>(null);
  const inputMetrics = useBoxMetrics(inputRef);
  const fallbackColumns = Math.max(1, columnsOverride ?? windowColumns - PROMPT_CHROME_COLUMNS);
  const columns = inputLayoutColumns(
    inputMetrics.hasMeasured && inputMetrics.width > 0 ? inputMetrics.width : fallbackColumns,
  );
  const [draft, setDraft] = useState<Draft>({
    value: initialValue,
    cursor: initialValue.length,
    anchor: null,
  });
  const attachments = usePromptAttachments({ reader: imageReader, onError: onPasteError });
  const [history, setHistory] = useState<string[]>([]);
  const [exitArmed, setExitArmed] = useState(false);
  const [paletteSelection, setPaletteSelection] = useState(0);
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  const historyIndex = useRef(-1);
  const savedDraft = useRef("");
  const exitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const maxVisibleLines =
    maxVisibleLinesOverride ??
    Math.max(MIN_INPUT_LINES, Math.min(MAX_INPUT_LINES, Math.floor(rows / 2) - 3));
  const selection = secret ? undefined : selectionRange(draft.anchor, draft.cursor);
  const {
    suggestions,
    hint: commandHint,
    remember: rememberCommand,
  } = useTuiCommandHints({
    value: draft.value,
    cursor: draft.cursor,
    enabled: commandsEnabled,
    secret,
    hasSelection: selection !== undefined,
  });
  const paletteOpen = !paletteDismissed && suggestions.length > 0;
  const selectedCommand =
    suggestions[Math.min(paletteSelection, Math.max(0, suggestions.length - 1))];

  useEffect(() => () => clearTimeout(exitTimer.current), []);

  useEffect(() => {
    onCommandPaletteChange?.(paletteOpen);
  }, [onCommandPaletteChange, paletteOpen]);

  const replace = (next: string, nextCursor: number) => {
    setDraft({
      value: next,
      cursor: Math.max(0, Math.min(next.length, nextCursor)),
      anchor: null,
    });
  };

  const edit = (next: string, nextCursor: number) => {
    setPaletteDismissed(false);
    setPaletteSelection(0);
    replace(next, nextCursor);
  };

  const removeSelection = (): boolean => {
    if (selection === undefined) return false;
    const next = deleteSelection(draft.value, selection);
    edit(next.value, next.cursor);
    return true;
  };

  const insert = (text: string) => {
    setExitArmed(false);
    setPaletteDismissed(false);
    setPaletteSelection(0);
    setDraft((current) => {
      const range = selectionRange(current.anchor, current.cursor);
      const start = range?.start ?? current.cursor;
      const end = range?.end ?? current.cursor;
      return {
        value: current.value.slice(0, start) + text + current.value.slice(end),
        cursor: start + text.length,
        anchor: null,
      };
    });
  };

  const handlePaste = (text: string): void => {
    const normalized = text.replace(/\r\n?/g, "\n");
    if (imageReader !== undefined) {
      if (normalized.length === 0) {
        void attachments.readClipboard();
        return;
      }
      const paths = imagePathsFromText(normalized);
      if (paths.length > 0) {
        void attachments.readPaths(paths);
        return;
      }
    }
    insert(normalized);
  };

  usePaste(handlePaste, { isActive: active });

  const submitText = (value: string, images: readonly ImageAttachment[] = attachments.images) => {
    const text = value.trim();
    if (text.length === 0 && images.length === 0 && !allowEmptySubmit) return;
    if (!secret && text.length > 0) rememberCommand(text);
    if (!secret && historyEnabled && text.length > 0) setHistory((current) => [...current, text]);
    historyIndex.current = -1;
    savedDraft.current = "";
    setExitArmed(false);
    setPaletteDismissed(false);
    replace("", 0);
    attachments.clear();
    if (images.length > 0) onSubmit(text, images);
    else onSubmit(text);
  };

  const submit = () => submitText(draft.value, attachments.images);

  const browse = (direction: -1 | 1) => {
    if (!historyEnabled || secret || history.length === 0) return;
    if (direction === -1) {
      if (historyIndex.current === -1) {
        savedDraft.current = draft.value;
        historyIndex.current = history.length - 1;
      } else if (historyIndex.current > 0) {
        historyIndex.current -= 1;
      }
    } else if (historyIndex.current !== -1) {
      if (historyIndex.current < history.length - 1) historyIndex.current += 1;
      else historyIndex.current = -1;
    }
    const next =
      historyIndex.current === -1 ? savedDraft.current : (history[historyIndex.current] ?? "");
    setPaletteSelection(0);
    replace(next, next.length);
    attachments.clear();
  };

  useInput(
    (input, key) => {
      if (key.ctrl && key.shift) return;
      if (key.ctrl && input === "r" && onToggleSecret !== undefined) {
        onToggleSecret();
        return;
      }
      if ((key.ctrl || key.super) && input === "v" && imageReader !== undefined) {
        void attachments.readClipboard();
        return;
      }
      if (key.ctrl && input === "c") {
        if (busy) return;
        if (!exitOnCtrlC) {
          if (draft.value.length > 0 || attachments.images.length > 0) {
            replace("", 0);
            attachments.clear();
          }
          return;
        }
        if (exitArmed) {
          exit();
          return;
        }
        if (draft.value.length > 0 || attachments.images.length > 0) {
          replace("", 0);
          attachments.clear();
        }
        setExitArmed(true);
        clearTimeout(exitTimer.current);
        exitTimer.current = setTimeout(() => setExitArmed(false), EXIT_ARM_MS);
        return;
      }
      if (key.ctrl && input === "x") {
        if (secret || selection === undefined) return;
        onCopyText?.(selectedText(draft.value, selection));
        removeSelection();
        return;
      }
      if (paletteOpen) {
        if (key.upArrow) {
          setPaletteSelection((current) => (current - 1 + suggestions.length) % suggestions.length);
          return;
        }
        if (key.downArrow) {
          setPaletteSelection((current) => (current + 1) % suggestions.length);
          return;
        }
        if (key.tab) {
          if (selectedCommand !== undefined) {
            const completed = completeTuiCommand(selectedCommand);
            setPaletteDismissed(true);
            replace(completed, completed.length);
          }
          return;
        }
        if (key.escape) {
          setPaletteDismissed(true);
          return;
        }
        if (key.return && !key.shift && selectedCommand !== undefined) {
          const trimmed = draft.value.trim();
          const names = [
            `/${selectedCommand.name}`,
            ...(selectedCommand.aliases ?? []).map((alias) => `/${alias}`),
          ];
          if (trimmed === "/" || names.includes(trimmed)) {
            setPaletteDismissed(true);
            submitText(`/${selectedCommand.name}`);
            return;
          }
          const completed = completeTuiCommand(selectedCommand);
          if (trimmed !== completed.trimEnd()) {
            setPaletteDismissed(true);
            replace(completed, completed.length);
            return;
          }
        }
      }
      if (key.escape) {
        if (onEscape !== undefined) {
          onEscape();
          return;
        }
        if (selectionActive) return;
        if (!busy && (draft.value.length > 0 || attachments.images.length > 0)) {
          replace("", 0);
          attachments.clear();
        }
        return;
      }
      if (key.return) {
        if (key.shift) {
          insert("\n");
          return;
        }
        if (draft.value[draft.cursor - 1] === "\\") {
          edit(
            `${draft.value.slice(0, draft.cursor - 1)}\n${draft.value.slice(draft.cursor)}`,
            draft.cursor,
          );
          return;
        }
        submit();
        return;
      }
      if (key.leftArrow) {
        if (selection !== undefined) replace(draft.value, selection.start);
        else replace(draft.value, previousGraphemeOffset(draft.value, draft.cursor));
        return;
      }
      if (key.rightArrow) {
        if (selection !== undefined) replace(draft.value, selection.end);
        else replace(draft.value, nextGraphemeOffset(draft.value, draft.cursor));
        return;
      }
      if (key.upArrow) {
        if (key.shift) return;
        const target = moveCursorVertically(draft.value, draft.cursor, columns, -1);
        if (target !== undefined) {
          replace(draft.value, target);
          return;
        }
        if (inputVisualLineCount(draft.value, draft.cursor, columns) === 1 && draft.cursor > 0) {
          replace(draft.value, 0);
          return;
        }
        browse(-1);
        return;
      }
      if (key.downArrow) {
        if (key.shift) return;
        const target = moveCursorVertically(draft.value, draft.cursor, columns, 1);
        if (target !== undefined) {
          replace(draft.value, target);
          return;
        }
        if (
          inputVisualLineCount(draft.value, draft.cursor, columns) === 1 &&
          draft.cursor < draft.value.length
        ) {
          replace(draft.value, draft.value.length);
          return;
        }
        browse(1);
        return;
      }
      if (key.ctrl && input === "a") {
        if (secret || draft.value.length === 0) return;
        setDraft({
          value: draft.value,
          cursor: draft.value.length,
          anchor: 0,
        });
        return;
      }
      if (key.home) {
        replace(draft.value, startOfLineOffset(draft.value, draft.cursor, columns));
        return;
      }
      if (key.end || (key.ctrl && input === "e")) {
        replace(draft.value, endOfLineOffset(draft.value, draft.cursor, columns));
        return;
      }
      if (key.ctrl && input === "u") {
        if (removeSelection()) return;
        edit(draft.value.slice(draft.cursor), 0);
        return;
      }
      if (key.ctrl && input === "k") {
        if (removeSelection()) return;
        edit(draft.value.slice(0, draft.cursor), draft.cursor);
        return;
      }
      if (key.ctrl && input === "w") {
        if (removeSelection()) return;
        const before = previousWordOffset(draft.value, draft.cursor);
        edit(draft.value.slice(0, before) + draft.value.slice(draft.cursor), before);
        return;
      }
      if (key.backspace) {
        if (removeSelection()) return;
        if (draft.cursor === 0) {
          attachments.removeLast();
          return;
        }
        const before = previousGraphemeOffset(draft.value, draft.cursor);
        edit(draft.value.slice(0, before) + draft.value.slice(draft.cursor), before);
        return;
      }
      if (key.delete) {
        if (removeSelection()) return;
        if (draft.cursor >= draft.value.length) return;
        const after = nextGraphemeOffset(draft.value, draft.cursor);
        edit(draft.value.slice(0, draft.cursor) + draft.value.slice(after), draft.cursor);
        return;
      }
      if (input.startsWith("\u001b")) return;
      if (key.tab) {
        if (suggestions.length > 0) {
          setPaletteDismissed(false);
          setPaletteSelection(0);
        }
        return;
      }
      if (key.ctrl || key.escape || key.pageUp || key.pageDown) return;
      if (input.length > 0) insert(input);
    },
    { isActive: active },
  );

  const placeholder = busy
    ? "运行中，Enter 排队 · Esc 取消 · Ctrl-C 取消"
    : exitArmed
      ? "再按一次 Ctrl-C 退出"
      : (idleHint ?? (showHints ? CONTROL_HINT : ""));
  return (
    <Box flexDirection="column" marginTop={marginTop} width="100%">
      {paletteOpen ? (
        <CommandPalette
          columns={windowColumns}
          commands={suggestions}
          selectedIndex={paletteSelection}
        />
      ) : null}
      <Box
        {...(showBorder
          ? {
              borderBottom: true,
              borderColor: busy ? TUI_THEME.inactive : TUI_THEME.promptBorder,
              borderStyle: "round" as const,
              paddingX: 1,
            }
          : { paddingX: 0 })}
        flexDirection="column"
        width="100%"
      >
        <AttachmentBar
          images={attachments.images}
          reading={attachments.reading}
          showHint={showHints}
        />
        <Box flexDirection="row" width="100%">
          {showPointer ? (
            <Box flexShrink={0} marginRight={1}>
              <Text color={busy ? TUI_THEME.inactive : TUI_THEME.text}>{POINTER}</Text>
            </Box>
          ) : null}
          <Box flexGrow={1} flexShrink={1} minWidth={0} ref={inputRef}>
            <TextInput
              columns={columns}
              cursor={draft.cursor}
              maxVisibleLines={maxVisibleLines}
              placeholder={placeholder}
              secret={secret}
              secretMask={secretMask}
              selectionEnd={selection?.end}
              selectionStart={selection?.start}
              value={draft.value}
            />
          </Box>
        </Box>
      </Box>
      {commandHint !== undefined && showHints ? (
        <Box paddingX={1}>
          <Text dimColor>{commandHint}</Text>
        </Box>
      ) : null}
      {exitArmed && showHints ? (
        <Text dimColor>再按一次 Ctrl-C 退出；输入任意内容可取消。</Text>
      ) : null}
    </Box>
  );
}
