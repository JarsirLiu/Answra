/** `/sessions` 会话浏览器：列表随选中项滚动、当前会话高亮、Enter 恢复、失败时保留列表。 */
import type { ConversationSessionSummary } from "@answra/shared";
import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { PanelFrame } from "../chrome/PanelFrame";
import { TUI_THEME } from "../chrome/theme";
import type { SessionsPanelData } from "./panel";

const VISIBLE_SESSIONS = 12;
const PAGE_STEP = VISIBLE_SESSIONS - 1;

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly data: SessionsPanelData }
  | { readonly kind: "error"; readonly message: string };

export function SessionsPanel({
  load,
  resume,
  close,
}: {
  load(cursor?: string): Promise<SessionsPanelData>;
  resume(conversationId: string): Promise<void>;
  close(): void;
}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();

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

  const sessions = state.kind === "ready" ? state.data.sessions : [];
  const current = state.kind === "ready" ? state.data.current : "";
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
    try {
      await resume(conversationId);
      close();
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
    (_input, key) => {
      if (busy || loadingMore) return;
      if (key.escape) {
        close();
        return;
      }
      if (sessions.length === 0) return;
      if (key.upArrow) {
        setSelected((index) => (index - 1 + sessions.length) % sessions.length);
        return;
      }
      if (key.downArrow) {
        if (selected === sessions.length - 1 && state.kind === "ready" && state.data.nextCursor) {
          void loadMore();
          return;
        }
        setSelected((index) => (index + 1) % sessions.length);
        return;
      }
      if (key.pageUp) {
        setSelected((index) => Math.max(0, index - PAGE_STEP));
        return;
      }
      if (key.pageDown) {
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
      description="选择要恢复的会话；Enter 恢复，Esc 关闭。删除请使用 /delete <完整 ID>。"
      footer={
        busy
          ? "正在恢复会话…"
          : loadingMore
            ? "正在加载更多会话…"
            : sessions.length === 0
              ? "Esc 关闭"
              : "↑/↓ 选择 · PgUp/PgDn 翻页 · Enter 恢复 · Esc 关闭"
      }
    >
      <Box flexDirection="column">
        {state.kind === "loading" ? <Text dimColor>正在读取历史会话…</Text> : null}
        {shownError === undefined ? null : (
          <Box marginBottom={1}>
            <Text color={TUI_THEME.error}>{shownError}</Text>
          </Box>
        )}
        {above > 0 ? <Text dimColor> ↑ {above} more…</Text> : null}
        {visible.map((item, index) => {
          const focused = windowStart + index === selected;
          const isCurrent = item.conversationId === current;
          return (
            <Box key={item.conversationId}>
              <Text color={focused ? TUI_THEME.suggestion : TUI_THEME.text}>
                {focused ? "❯" : " "}
              </Text>
              <Text color={isCurrent ? TUI_THEME.success : TUI_THEME.inactive}>
                {" "}
                {isCurrent ? "✓" : " "}
              </Text>
              <Text bold={focused} color={focused ? TUI_THEME.suggestion : TUI_THEME.text}>
                {" "}
                {sessionLabel(item)}
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

function sessionLabel(item: ConversationSessionSummary): string {
  const stamp = item.updatedAt.slice(0, 16).replace("T", " ");
  return `${item.conversationId.slice(0, 8)}  ${stamp}  ${item.title}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}
