import { MessageSquareText, Sparkles, X } from "lucide-react";
import { type FormEvent, type RefObject, useEffect, useRef } from "react";
import { ICON_SM } from "../../tokens";
import type { ChatAttachment, ChatMessage } from "./ChatPanel";
import { PanelShell } from "./PanelShell";
import "./ReplyBar.css";

interface ReplyBarProps {
  /** 会话消息流（与 AI 对话面板共用同一份 state）。 */
  messages: ChatMessage[];
  /** 本轮预备发送的多张截图。 */
  attachments: ChatAttachment[];
  draft: string;
  /** 隐藏的文件选择框 ref（无捕获桥时回落选择本地图片）。 */
  fileInputRef: RefObject<HTMLInputElement | null>;
  onDraftChange: (value: string) => void;
  /** 从文件选择框追加一张本地图片。 */
  onAttachmentChange: (file: File | null) => void;
  /** 移除某张预备截图（按 id）。 */
  onAttachmentRemove: (id: string) => void;
  /** 取消发送：清空本轮未发送的消息（截图 + 草稿）。 */
  onClearAll: () => void;
  onSend: () => void;
  onClose: () => void;
}

/**
 * 原地回复条：截图提问走这里，而非打开完整对话面板。
 * 上方是会话流（AI 回复自动滚到底），下方是预备发送区（多图缩略条 + 输入框 + 取消/发送）。
 */
export function ReplyBar({
  messages,
  attachments,
  draft,
  fileInputRef,
  onDraftChange,
  onAttachmentChange,
  onAttachmentRemove,
  onClearAll,
  onSend,
  onClose,
}: ReplyBarProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // AI 回复到位后自动滚到底
  // biome-ignore lint/correctness/useExhaustiveDependencies: 依赖 messages 变化触发滚动，body 内只操作 DOM 故未直接引用
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSend();
  }

  return (
    <PanelShell className="reply-bar" onClose={onClose} title="回复" variant="chat">
      <div aria-live="polite" className="conversation" ref={scrollRef}>
        {messages.map((message) => (
          <article className={`chat-message chat-message--${message.role}`} key={message.id}>
            {message.role === "assistant" && (
              <div className="assistant-avatar">
                <Sparkles aria-hidden="true" size={ICON_SM} />
              </div>
            )}
            <div className="message-content">
              {message.attachments?.map((att) => (
                <figure className="message-attachment" key={att.id}>
                  <img alt={`用户添加的截图：${att.name}`} src={att.previewUrl} />
                  <figcaption>{att.name}</figcaption>
                </figure>
              ))}
              {message.content}
            </div>
          </article>
        ))}
      </div>
      <form className="composer input-surface" onSubmit={handleSubmit}>
        <input
          accept="image/*"
          aria-label="选择截图图片"
          className="file-input-hidden"
          onChange={(event) => {
            onAttachmentChange(event.target.files?.[0] ?? null);
            event.target.value = "";
          }}
          ref={fileInputRef}
          type="file"
        />
        {attachments.length > 0 && (
          <div className="attachment-strip">
            {attachments.map((att) => (
              <div className="attachment-thumb" key={att.id}>
                <img alt="待发送截图预览" src={att.previewUrl} />
                <button
                  aria-label="移除截图"
                  onClick={() => onAttachmentRemove(att.id)}
                  type="button"
                >
                  <X aria-hidden="true" size={ICON_SM} />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          aria-label="补充问题"
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={attachments.length ? "补充问题或说明…" : "输入问题，或先从模式功能添加截图…"}
          value={draft}
        />
        <div className="composer-footer">
          <span>演示模式 · 尚未连接 AI</span>
          <div className="composer-actions">
            <button
              aria-label="取消发送"
              className="button-ghost"
              onClick={onClearAll}
              type="button"
            >
              取消发送
            </button>
            <button
              aria-label="发送给 AI"
              disabled={!draft.trim() && attachments.length === 0}
              type="submit"
            >
              <MessageSquareText aria-hidden="true" size={ICON_SM} />
              发送
            </button>
          </div>
        </div>
      </form>
    </PanelShell>
  );
}
