/** Claude 风格输入框：底部边框、宽字符光标、历史浏览、Enter 提交与多行换行。 */
import { Box, Text, useApp, useInput, usePaste, useWindowSize } from "ink";
import { useEffect, useRef, useState } from "react";
import { POINTER, TUI_THEME } from "../theme";
import { nextGraphemeOffset, previousGraphemeOffset, previousWordOffset } from "./inputLayout";
import { TextInput } from "./TextInput";

const CONTROL_HINT = "Enter 发送 · Shift+Enter 或 \\ + Enter 换行 · Esc 取消 · Ctrl-C 两次退出";
const EXIT_ARM_MS = 2_000;
const MIN_INPUT_LINES = 3;
const MAX_INPUT_LINES = 8;

interface Draft {
  readonly value: string;
  readonly cursor: number;
}

export function PromptInput({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (text: string) => void;
}) {
  const { exit } = useApp();
  const { rows } = useWindowSize();
  const [draft, setDraft] = useState<Draft>({ value: "", cursor: 0 });
  const [history, setHistory] = useState<string[]>([]);
  const [exitArmed, setExitArmed] = useState(false);
  const historyIndex = useRef(-1);
  const savedDraft = useRef("");
  const exitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const maxVisibleLines = Math.max(
    MIN_INPUT_LINES,
    Math.min(MAX_INPUT_LINES, Math.floor(rows / 2) - 3),
  );

  useEffect(() => () => clearTimeout(exitTimer.current), []);

  const replace = (next: string, nextCursor: number) => {
    setDraft({
      value: next,
      cursor: Math.max(0, Math.min(next.length, nextCursor)),
    });
  };

  const insert = (text: string) => {
    setExitArmed(false);
    setDraft((current) => ({
      value: current.value.slice(0, current.cursor) + text + current.value.slice(current.cursor),
      cursor: current.cursor + text.length,
    }));
  };

  usePaste((text) => insert(text));

  const submit = () => {
    const text = draft.value.trim();
    if (text.length === 0) return;
    setHistory((current) => [...current, text]);
    historyIndex.current = -1;
    savedDraft.current = "";
    setExitArmed(false);
    replace("", 0);
    onSubmit(text);
  };

  const browse = (direction: -1 | 1) => {
    if (history.length === 0) return;
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
    replace(next, next.length);
  };

  useInput((input, key) => {
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
    if (key.escape) {
      if (!busy && draft.value.length > 0) replace("", 0);
      return;
    }
    if (key.return) {
      if (key.shift) {
        insert("\n");
        return;
      }
      if (draft.value[draft.cursor - 1] === "\\") {
        replace(
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
      browse(-1);
      return;
    }
    if (key.downArrow) {
      browse(1);
      return;
    }
    if (key.home || (key.ctrl && input === "a")) {
      replace(draft.value, 0);
      return;
    }
    if (key.end || (key.ctrl && input === "e")) {
      replace(draft.value, draft.value.length);
      return;
    }
    if (key.ctrl && input === "u") {
      replace(draft.value.slice(draft.cursor), 0);
      return;
    }
    if (key.ctrl && input === "k") {
      replace(draft.value.slice(0, draft.cursor), draft.cursor);
      return;
    }
    if (key.ctrl && input === "w") {
      const before = previousWordOffset(draft.value, draft.cursor);
      replace(draft.value.slice(0, before) + draft.value.slice(draft.cursor), before);
      return;
    }
    if (key.backspace) {
      if (draft.cursor === 0) return;
      const before = previousGraphemeOffset(draft.value, draft.cursor);
      replace(draft.value.slice(0, before) + draft.value.slice(draft.cursor), before);
      return;
    }
    if (key.delete) {
      if (draft.cursor >= draft.value.length) return;
      const after = nextGraphemeOffset(draft.value, draft.cursor);
      replace(draft.value.slice(0, draft.cursor) + draft.value.slice(after), draft.cursor);
      return;
    }
    if (input.startsWith("\u001b")) return;
    if (key.ctrl || key.escape || key.tab || key.pageUp || key.pageDown) return;
    if (input.length > 0) insert(input);
  });

  const placeholder = busy
    ? "运行中，Enter 排队 · Esc 取消 · Ctrl-C 取消"
    : exitArmed
      ? "再按一次 Ctrl-C 退出"
      : CONTROL_HINT;
  return (
    <Box flexDirection="column" marginTop={1} width="100%">
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
            cursor={draft.cursor}
            maxVisibleLines={maxVisibleLines}
            placeholder={placeholder}
            value={draft.value}
          />
        </Box>
      </Box>
      {exitArmed ? <Text dimColor>再按一次 Ctrl-C 退出；输入任意内容可取消。</Text> : null}
    </Box>
  );
}
