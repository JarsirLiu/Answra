import type { ConversationSessionSummary } from "@answra/shared";
import { useState } from "react";
import { SurfaceButton } from "../controls/SurfaceButton";
import "./ChatHistoryPanel.css";

export interface ChatHistoryPanelProps {
  sessions: readonly ConversationSessionSummary[];
  activeConversationId: string;
  disabledReason?: string;
  error?: string;
  hasMore?: boolean;
  loading?: boolean;
  onLoadMore?: () => void;
  onResume: (conversationId: string) => void;
  onDelete: (conversationId: string) => Promise<void>;
}

/** 纯展示的历史列表；会话状态与 IPC 由 useChatSessions 持有。 */
export function ChatHistoryPanel({
  sessions,
  activeConversationId,
  disabledReason,
  error,
  hasMore = false,
  loading = false,
  onLoadMore,
  onResume,
  onDelete,
}: ChatHistoryPanelProps) {
  const [confirmId, setConfirmId] = useState<string>();

  if (sessions.length === 0) {
    return (
      <section aria-label="会话历史" className="chat-history">
        {error ? <p className="chat-history-error">{error}</p> : null}
        <p className="chat-history-empty">还没有历史会话。发送第一条消息后会出现在这里。</p>
      </section>
    );
  }

  return (
    <section aria-label="会话历史" className="chat-history">
      {error ? <p className="chat-history-error">{error}</p> : null}
      <ul className="chat-history-list">
        {sessions.map((session) => {
          const active = session.conversationId === activeConversationId;
          const confirming = confirmId === session.conversationId;
          return (
            <li className="chat-history-row" key={session.conversationId}>
              <div className="chat-history-main">
                <span className="chat-history-title">
                  {session.title}
                  {active ? <span className="chat-history-active">当前</span> : null}
                </span>
                <span className="chat-history-meta">
                  {formatUpdatedAt(session.updatedAt)} · {session.messageCount} 条消息
                </span>
                <span className="chat-history-id">{session.conversationId}</span>
              </div>
              <div className="chat-history-actions">
                <SurfaceButton
                  aria-label={`继续会话 ${session.conversationId}`}
                  disabled={Boolean(disabledReason) || active}
                  onClick={() => onResume(session.conversationId)}
                  size="sm"
                  variant="quiet"
                >
                  继续
                </SurfaceButton>
                <SurfaceButton
                  aria-label={`${confirming ? "确认删除" : "删除"}会话 ${session.conversationId}`}
                  disabled={Boolean(disabledReason)}
                  onClick={() => {
                    if (!confirming) {
                      setConfirmId(session.conversationId);
                      return;
                    }
                    setConfirmId(undefined);
                    void onDelete(session.conversationId);
                  }}
                  size="sm"
                  variant="quiet"
                >
                  {confirming ? "确认删除" : "删除"}
                </SurfaceButton>
              </div>
            </li>
          );
        })}
      </ul>
      {hasMore ? (
        <SurfaceButton
          aria-label="加载更多会话"
          disabled={loading || onLoadMore === undefined}
          onClick={onLoadMore}
          size="sm"
          variant="quiet"
        >
          {loading ? "加载中…" : "加载更多"}
        </SurfaceButton>
      ) : null}
    </section>
  );
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
