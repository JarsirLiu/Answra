/** Claude 风格输入框：底部边框、宽字符光标、历史浏览、Enter 提交与多行换行。 */
import { Box, Text, useApp, useInput, usePaste, useWindowSize } from "ink";
import { useEffect, useRef, useState } from "react";
import { POINTER, TUI_THEME } from "../chrome/theme";
import { CommandPalette } from "../commands/CommandPalette";
import { completeTuiCommand, suggestTuiCommands, tuiCommandPrefix } from "../commands/catalog";
import {
  endOfLineOffset,
  moveCursorVertically,
  nextGraphemeOffset,
  previousGraphemeOffset,
  previousWordOffset,
  startOfLineOffset,
} from "./inputLayout";
import { TextInput } from "./TextInput";

const CONTROL_HINT = "Enter 发送 · Shift+Enter 或 \\ + Enter 换行 · Esc 取消 · Ctrl-C 两次退出";
const EXIT_ARM_MS = 2_000;
const MIN_INPUT_LINES = 3;
const MAX_INPUT_LINES = 8;
const PROMPT_CHROME_COLUMNS = 4;

interface Draft {
  readonly value: string;
  readonly cursor: number;
}

export function PromptInput({
  busy,
  onSubmit,
  selectionActive = false,
  idleHint,
  secret = false,
  allowEmptySubmit = false,
  onCommandPaletteChange,
}: {
  busy: boolean;
  onSubmit: (text: string) => void;
  selectionActive?: boolean;
  idleHint?: string;
  secret?: boolean;
  allowEmptySubmit?: boolean;
  onCommandPaletteChange?: (open: boolean) => void;
}) {
  const { exit } = useApp();
  const { columns: windowColumns, rows } = useWindowSize();
  const columns = Math.max(1, windowColumns - PROMPT_CHROME_COLUMNS);
  const [draft, setDraft] = useState<Draft>({ value: "", cursor: 0 });
  const [history, setHistory] = useState<string[]>([]);
  const [exitArmed, setExitArmed] = useState(false);
  const [paletteSelection, setPaletteSelection] = useState(0);
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  const historyIndex = useRef(-1);
  const savedDraft = useRef("");
  const exitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const maxVisibleLines = Math.max(
    MIN_INPUT_LINES,
    Math.min(MAX_INPUT_LINES, Math.floor(rows / 2) - 3),
  );
  const commandPrefix = tuiCommandPrefix(draft.value);
  const suggestions =
    secret || commandPrefix === undefined ? [] : suggestTuiCommands(commandPrefix);
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
    });
  };

  const edit = (next: string, nextCursor: number) => {
    setPaletteDismissed(false);
    setPaletteSelection(0);
    replace(next, nextCursor);
  };

  const insert = (text: string) => {
    setExitArmed(false);
    setPaletteDismissed(false);
    setPaletteSelection(0);
    setDraft((current) => ({
      value: current.value.slice(0, current.cursor) + text + current.value.slice(current.cursor),
      cursor: current.cursor + text.length,
    }));
  };

  usePaste((text) => insert(text.replace(/\r\n?/g, "\n")));

  const submit = () => {
    const text = draft.value.trim();
    if (text.length === 0 && !allowEmptySubmit) return;
    if (!secret) setHistory((current) => [...current, text]);
    historyIndex.current = -1;
    savedDraft.current = "";
    setExitArmed(false);
    setPaletteDismissed(false);
    replace("", 0);
    onSubmit(text);
  };

  const browse = (direction: -1 | 1) => {
    if (secret || history.length === 0) return;
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
  };

  useInput((input, key) => {
    if (key.ctrl && key.shift) return;
    if (key.ctrl && input === "c") {
      if (busy) return;
      if (exitArmed) {
        exit();
        return;
      }
      if (draft.value.length > 0) replace("", 0);
      setExitArmed(true);
      clearTimeout(exitTimer.current);
      exitTimer.current = setTimeout(() => setExitArmed(false), EXIT_ARM_MS);
      return;
    }
    if (paletteOpen) {
      if (key.upArrow) {
        setPaletteSelection((current) => Math.max(0, current - 1));
        return;
      }
      if (key.downArrow) {
        setPaletteSelection((current) => Math.min(suggestions.length - 1, current + 1));
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
        const completed = completeTuiCommand(selectedCommand);
        if (draft.value.trim() !== completed.trimEnd()) {
          setPaletteDismissed(true);
          replace(completed, completed.length);
          return;
        }
      }
    }
    if (key.escape) {
      if (selectionActive) return;
      if (!busy && draft.value.length > 0) replace("", 0);
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
      replace(draft.value, previousGraphemeOffset(draft.value, draft.cursor));
      return;
    }
    if (key.rightArrow) {
      replace(draft.value, nextGraphemeOffset(draft.value, draft.cursor));
      return;
    }
    if (key.upArrow) {
      if (key.shift) return;
      const target = moveCursorVertically(draft.value, draft.cursor, columns, -1);
      if (target === undefined) browse(-1);
      else replace(draft.value, target);
      return;
    }
    if (key.downArrow) {
      if (key.shift) return;
      const target = moveCursorVertically(draft.value, draft.cursor, columns, 1);
      if (target === undefined) browse(1);
      else replace(draft.value, target);
      return;
    }
    if (key.home || (key.ctrl && input === "a")) {
      replace(draft.value, startOfLineOffset(draft.value, draft.cursor, columns));
      return;
    }
    if (key.end || (key.ctrl && input === "e")) {
      replace(draft.value, endOfLineOffset(draft.value, draft.cursor, columns));
      return;
    }
    if (key.ctrl && input === "u") {
      edit(draft.value.slice(draft.cursor), 0);
      return;
    }
    if (key.ctrl && input === "k") {
      edit(draft.value.slice(0, draft.cursor), draft.cursor);
      return;
    }
    if (key.ctrl && input === "w") {
      const before = previousWordOffset(draft.value, draft.cursor);
      edit(draft.value.slice(0, before) + draft.value.slice(draft.cursor), before);
      return;
    }
    if (key.backspace) {
      if (draft.cursor === 0) return;
      const before = previousGraphemeOffset(draft.value, draft.cursor);
      edit(draft.value.slice(0, before) + draft.value.slice(draft.cursor), before);
      return;
    }
    if (key.delete) {
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
  });

  const placeholder = busy
    ? "运行中，Enter 排队 · Esc 取消 · Ctrl-C 取消"
    : exitArmed
      ? "再按一次 Ctrl-C 退出"
      : (idleHint ?? CONTROL_HINT);
  return (
    <Box flexDirection="column" marginTop={1} width="100%">
      {paletteOpen ? (
        <CommandPalette commands={suggestions} selectedIndex={paletteSelection} />
      ) : null}
      <Box
        borderBottom
        borderColor={busy ? TUI_THEME.inactive : TUI_THEME.promptBorder}
        borderStyle="round"
        paddingX={1}
        width="100%"
      >
        <Box flexShrink={0} marginRight={1}>
          <Text color={busy ? TUI_THEME.inactive : TUI_THEME.text}>{POINTER}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <TextInput
            columns={columns}
            cursor={draft.cursor}
            maxVisibleLines={maxVisibleLines}
            placeholder={placeholder}
            secret={secret}
            value={draft.value}
          />
        </Box>
      </Box>
      {exitArmed ? <Text dimColor>再按一次 Ctrl-C 退出；输入任意内容可取消。</Text> : null}
    </Box>
  );
}
