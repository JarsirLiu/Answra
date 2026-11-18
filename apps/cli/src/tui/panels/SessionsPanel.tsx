/** `/sessions` 会话浏览器：列表随选中项滚动、当前会话高亮、Enter 恢复、Ctrl+Y 复制 ID、Ctrl+D 二次确认删除。 */
import type { ConversationSessionSummary } from "@answra/shared";
import { Box, Text, useInput, useWindowSize } from "ink";
import { useEffect, useState } from "react";
import { PanelFrame } from "../chrome/PanelFrame";
import { POINTER, TUI_THEME } from "../chrome/theme";
import { truncateToWidth } from "../commands/paletteLayout";
import type { SessionsPanelData } from "./panel";

const VISIBLE_SESSIONS = 12;
const PAGE_STEP = VISIBLE_SESSIONS - 1;
/** 标记列（`❯` + 状态勾 + 空格）宽度；标题按剩余终端宽度截断，不折行。 */
const LABEL_PREFIX_COLUMNS = 3;
/** 行首左对齐的短 ID 与时间戳占位：`xxxxxxxx` + 两个空格 + `YYYY-MM-DD HH:mm` + 两个空格。 */
const ID_LENGTH = 8;
const STAMP_LENGTH = 16;
const ID_AND_STAMP_COLUMNS = ID_LENGTH + STAMP_LENGTH + 4;

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly data: SessionsPanelData }
  | { readonly kind: "error"; readonly message: string };

export function SessionsPanel({
  load,
  resume,
  remove,
  copyText,
  close,
}: {
  load(cursor?: string): Promise<SessionsPanelData>;
  resume(conversationId: string): Promise<void>;
  remove(conversationId: string): Promise<void>;
  copyText?(text: string): void;
  close(): void;
}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [pendingDelete, setPendingDelete] = useState<string>();

  useEffect(() => {
    let alive = true;
    load()
      .then((data) => {
        if (!alive) return;
        setState({ kind: "ready", data });
        const currentIndex = data.sessions.findIndex(
          (item) => item.conversationId === data.current,
        );
        if (currentIndex > 0) setSelected(currentIndex);
      })
      .catch((cause: unknown) => {
        if (alive) setState({ kind: "error", message: messageOf(cause) });
      });
    return () => {
      alive = false;
    };
  }, [load]);

  const { columns } = useWindowSize();
  const sessions = state.kind === "ready" ? state.data.sessions : [];
  const current = state.kind === "ready" ? state.data.current : "";
  const titleColumns = Math.max(8, columns - LABEL_PREFIX_COLUMNS - ID_AND_STAMP_COLUMNS);
  const maxStart = Math.max(0, sessions.length - VISIBLE_SESSIONS);
  const windowStart = Math.min(Math.max(0, selected - VISIBLE_SESSIONS + 1), maxStart);
  const visible = sessions.slice(windowStart, windowStart + VISIBLE_SESSIONS);
  const above = windowStart;
  const below = sessions.length - windowStart - visible.length;
  const hasMore = state.kind === "ready" && state.data.nextCursor !== undefined;
  const loadError =
    state.kind === "error" ? state.message : state.kind === "ready" ? state.data.error : undefined;
  const shownError = error ?? loadError;

  const choose = async (conversationId: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await resume(conversationId);
      close();
    } catch (cause) {
      setBusy(false);
      setError(messageOf(cause));
    }
  };

  const removeSelected = async (item: ConversationSessionSummary): Promise<void> => {
    if (busy) return;
    const isCurrent = item.conversationId === current;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    setPendingDelete(undefined);
    try {
      await remove(item.conversationId);
      if (isCurrent) {
        close();
        return;
      }
      setState((previous) => {
        if (previous.kind !== "ready") return previous;
        return {
          kind: "ready",
          data: {
            ...previous.data,
            sessions: previous.data.sessions.filter(
              (session) => session.conversationId !== item.conversationId,
            ),
          },
        };
      });
      setSelected((index) => Math.max(0, Math.min(index, sessions.length - 2)));
      setNotice(`已删除会话：${item.conversationId}`);
      setBusy(false);
    } catch (cause) {
      setBusy(false);
      setError(messageOf(cause));
    }
  };

  const loadMore = async (): Promise<void> => {
    if (state.kind !== "ready" || state.data.nextCursor === undefined || loadingMore || busy)
      return;
    setLoadingMore(true);
    setError(undefined);
    try {
      const next = await load(state.data.nextCursor);
      setState((previous) => {
        if (previous.kind !== "ready") return previous;
        const merged = new Map(
          [...previous.data.sessions, ...next.sessions].map((item) => [item.conversationId, item]),
        );
        return {
          kind: "ready",
          data: {
            ...previous.data,
            current: next.current,
            sessions: [...merged.values()],
            nextCursor: next.nextCursor,
            error: next.error,
          },
        };
      });
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoadingMore(false);
    }
  };

  useInput(
    (input, key) => {
      if (busy || loadingMore) return;
      if (key.ctrl && input === "y") {
        const target = sessions[selected];
        if (target !== undefined) {
          copyText?.(target.conversationId);
          setNotice(`已复制会话 ID：${target.conversationId}`);
        }
        return;
      }
      if (key.ctrl && input === "d") {
        const target = sessions[selected];
        if (target === undefined) return;
        if (pendingDelete === target.conversationId) {
          void removeSelected(target);
        } else {
          setPendingDelete(target.conversationId);
          setNotice(`再按 Ctrl+D 确认删除：${target.conversationId}`);
        }
        return;
      }
      if (key.escape) {
        close();
        return;
      }
      if (sessions.length === 0) return;
      if (key.upArrow) {
        setPendingDelete(undefined);
        setNotice(undefined);
        setSelected((index) => (index - 1 + sessions.length) % sessions.length);
        return;
      }
      if (key.downArrow) {
        setPendingDelete(undefined);
        setNotice(undefined);
        if (selected === sessions.length - 1 && state.kind === "ready" && state.data.nextCursor) {
          void loadMore();
          return;
        }
        setSelected((index) => (index + 1) % sessions.length);
        return;
      }
      if (key.pageUp) {
        setPendingDelete(undefined);
        setNotice(undefined);
        setSelected((index) => Math.max(0, index - PAGE_STEP));
        return;
      }
      if (key.pageDown) {
        setPendingDelete(undefined);
        setNotice(undefined);
        if (selected === sessions.length - 1 && state.kind === "ready" && state.data.nextCursor) {
          void loadMore();
          return;
        }
        setSelected((index) => Math.min(sessions.length - 1, index + PAGE_STEP));
        return;
      }
      if (!key.return) return;
      const target = sessions[selected];
      if (target !== undefined) void choose(target.conversationId);
    },
    { isActive: !busy && !loadingMore },
  );

  return (
    <PanelFrame
      title="历史会话"
      description="选择要恢复的会话；Enter 恢复，Ctrl+Y 复制完整 ID，Ctrl+D 删除，Esc 关闭。"
      footer={
        busy
          ? "正在处理会话…"
          : loadingMore
            ? "正在加载更多会话…"
            : sessions.length === 0
              ? "Esc 关闭"
              : "↑/↓ 选择 · PgUp/PgDn 翻页 · Enter 恢复 · Ctrl+Y 复制 ID · Ctrl+D 删除 · Esc 关闭"
      }
    >
      <Box flexDirection="column">
        {state.kind === "loading" ? <Text dimColor>正在读取历史会话…</Text> : null}
        {shownError === undefined ? null : (
          <Box marginBottom={1}>
            <Text color={TUI_THEME.error}>{shownError}</Text>
          </Box>
        )}
        {notice === undefined ? null : (
          <Box marginBottom={1}>
            <Text dimColor>{notice}</Text>
          </Box>
        )}
        {above > 0 ? <Text dimColor> ↑ {above} more…</Text> : null}
        {visible.map((item, index) => {
          const focused = windowStart + index === selected;
          const isCurrent = item.conversationId === current;
          const rowColor = focused ? TUI_THEME.suggestion : TUI_THEME.text;
          return (
            <Box key={item.conversationId}>
              <Text color={rowColor}>{focused ? POINTER : " "}</Text>
              <Text color={isCurrent ? TUI_THEME.success : TUI_THEME.inactive}>
                {" "}
                {isCurrent ? "✓" : " "}
              </Text>
              <Text bold={focused} color={rowColor}>
                {" "}
                {sessionId(item)}
              </Text>
              <Text dimColor> {sessionStamp(item)}</Text>
              <Text bold={focused} color={rowColor} wrap="truncate">
                {" "}
                {truncateToWidth(sessionTitle(item), titleColumns)}
              </Text>
              {isCurrent ? <Text dimColor> Current session</Text> : null}
            </Box>
          );
        })}
        {below > 0 || hasMore ? (
          <Text dimColor> ↓ {below > 0 ? `${below} more…` : "more…"}</Text>
        ) : null}
        {state.kind === "ready" && sessions.length === 0 && shownError === undefined ? (
          <Text dimColor>当前 workspace 还没有历史会话。</Text>
        ) : null}
      </Box>
    </PanelFrame>
  );
}

function sessionId(item: ConversationSessionSummary): string {
  return item.conversationId.slice(0, ID_LENGTH).padEnd(ID_LENGTH);
}

function sessionStamp(item: ConversationSessionSummary): string {
  return item.updatedAt.slice(0, STAMP_LENGTH).replace("T", " ");
}

/** 标题只保留单行：折叠换行与连续空白，宽度截断留给调用点按终端列宽处理。 */
function sessionTitle(item: ConversationSessionSummary): string {
  return item.title.replace(/\s+/g, " ").trim();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}
