import { MessageSquareText, Sparkles, X } from "lucide-react";
import type { FormEvent, RefObject } from "react";
import { ICON_SM } from "../../tokens";
import { PanelShell } from "./PanelShell";

export interface ChatAttachment {
  name: string;
  previewUrl: string;
}

export interface ChatMessage {
  id: string;
  role: "assistant" | "user";
  content: string;
  attachment?: ChatAttachment;
}

interface ChatPanelProps {
  messages: ChatMessage[];
  draft: string;
  attachment: ChatAttachment | null;
  modeLabel: string;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onDraftChange: (value: string) => void;
  onAttachmentChange: (file: File | null) => void;
  onAttachmentRemove: () => void;
  onSend: () => void;
  onClose: () => void;
}

/** AI 对话面板：消息流 + 截图附件 + 输入区。 */
export function ChatPanel({
  messages,
  draft,
  attachment,
  modeLabel,
  fileInputRef,
  onDraftChange,
  onAttachmentChange,
  onAttachmentRemove,
  onSend,
  onClose,
}: ChatPanelProps) {
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSend();
  }

  return (
    <PanelShell
      context={attachment ? "截图已添加，可补充问题" : "对话"}
      modeLabel={modeLabel}
      onClose={onClose}
      title="AI 对话"
      variant="chat"
    >
      <div aria-live="polite" className="conversation">
        {messages.map((message) => (
          <article className={`chat-message chat-message--${message.role}`} key={message.id}>
            {message.role === "assistant" && (
              <div className="assistant-avatar">
                <Sparkles aria-hidden="true" size={ICON_SM} />
              </div>
            )}
            <div className="message-content">
              {message.attachment && (
                <figure className="message-attachment">
                  <img
                    alt={`用户添加的截图：${message.attachment.name}`}
                    src={message.attachment.previewUrl}
                  />
                  <figcaption>{message.attachment.name}</figcaption>
                </figure>
              )}
              {message.content}
            </div>
          </article>
        ))}
      </div>
      <form className="composer" onSubmit={handleSubmit}>
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
        {attachment && (
          <div className="attachment-preview">
            <img alt="待发送截图预览" src={attachment.previewUrl} />
            <span>{attachment.name}</span>
            <button aria-label="移除截图" onClick={onAttachmentRemove} type="button">
              <X aria-hidden="true" size={ICON_SM} />
            </button>
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
          placeholder={attachment ? "补充问题或说明…" : "输入问题，或先从模式功能添加截图…"}
          value={draft}
        />
        <div className="composer-footer">
          <span>演示模式 · 尚未连接 AI</span>
          <button aria-label="发送给 AI" disabled={!draft.trim() && !attachment} type="submit">
            <MessageSquareText aria-hidden="true" size={ICON_SM} />
            发送
          </button>
        </div>
      </form>
    </PanelShell>
  );
}
