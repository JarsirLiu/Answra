import { Sparkles, X } from "lucide-react";
import type { RefObject } from "react";
import { ICON_SM } from "../../tokens";
import { ConversationComposer } from "./ConversationComposer";
import { PanelShell } from "./PanelShell";
import "./ChatPanel.css";

export interface ChatAttachment {
  id: string;
  name: string;
  previewUrl: string;
}

export interface ChatMessage {
  id: string;
  role: "assistant" | "user";
  content: string;
  attachments?: ChatAttachment[];
}

interface ChatPanelProps {
  messages: ChatMessage[];
  draft: string;
  attachments: ChatAttachment[];
  fileInputRef: RefObject<HTMLInputElement | null>;
  onDraftChange: (value: string) => void;
  onAttachmentChange: (file: File | null) => void;
  onAttachmentRemove: (id: string) => void;
  onSend: () => void;
  onCancel: () => void;
  configured: boolean;
  streaming: boolean;
  onClose: () => void;
}

/** AI 对话面板：消息流 + 截图附件 + 输入区。 */
export function ChatPanel({
  messages,
  draft,
  attachments,
  fileInputRef,
  onDraftChange,
  onAttachmentChange,
  onAttachmentRemove,
  onSend,
  onCancel,
  configured,
  streaming,
  onClose,
}: ChatPanelProps) {
  return (
    <PanelShell
      context={attachments.length ? "截图已添加，可补充问题" : undefined}
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
              {message.attachments?.map((att) => (
                <figure className="message-attachment" key={att.id}>
                  <img alt="用户添加的截图" src={att.previewUrl} />
                </figure>
              ))}
              {message.content}
            </div>
          </article>
        ))}
      </div>
      <ConversationComposer
        footerLabel={configured ? "OpenAI-compatible" : "请先配置模型服务"}
        inputLabel="补充问题"
        onAddAttachment={() => fileInputRef.current?.click()}
        onSubmit={onSend}
        onValueChange={onDraftChange}
        placeholder={attachments.length ? "补充问题或说明…" : "输入问题，或先从模式功能添加截图…"}
        submitDisabled={streaming || (!draft.trim() && attachments.length === 0)}
        value={draft}
        beforeSubmit={
          streaming ? (
            <button
              aria-label="停止回复"
              className="composer-stop-button"
              onClick={onCancel}
              type="button"
            >
              停止
            </button>
          ) : null
        }
      >
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
        {attachments.map((att) => (
          <div className="attachment-preview" key={att.id}>
            <img alt="待发送截图预览" src={att.previewUrl} />
            <span>{att.name}</span>
            <button aria-label="移除截图" onClick={() => onAttachmentRemove(att.id)} type="button">
              <X aria-hidden="true" size={ICON_SM} />
            </button>
          </div>
        ))}
      </ConversationComposer>
    </PanelShell>
  );
}
