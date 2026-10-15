import type { DesktopBridge } from "@answra/shared";
import { X } from "lucide-react";
import { type RefObject, useLayoutEffect, useRef } from "react";
import { ICON_SM } from "../../tokens";
import { AssistantMessage, MessageStream } from "../chat";
import { ConversationComposer } from "./ConversationComposer";
import { PanelShell } from "./PanelShell";
import "./ChatPanel.css";
import { useEmbeddedIme } from "../../hooks/useEmbeddedIme";

export interface ChatAttachment {
  id: string;
  name: string;
  previewUrl: string;
}

export interface ChatMessage {
  id: string;
  role: "assistant" | "user";
  content: string;
  /** 模型思维链（reasoning part），流式更新；可能为空。 */
  reasoning?: string;
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
  streaming: boolean;
  /** 本轮思考耗时（毫秒），回答开始输出后冻结。 */
  thinkingMs?: number;
  /** 分叉对话：从当前消息开启新对话。 */
  onFork?: () => void;
  /** 点赞/点踩反馈。 */
  onVote?: (vote: "up" | "down" | null) => void;
  onClose: () => void;
  bridge?: DesktopBridge;
  stealth: boolean;
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
  streaming,
  thinkingMs,
  onFork,
  onVote,
  onClose,
  bridge,
}: ChatPanelProps) {
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(draft);
  const preeditLengthRef = useRef(0);
  const composingRangeRef = useRef<{ start: number; end: number } | null>(null);
  const pendingCaretRef = useRef<number | null>(null);
  draftRef.current = draft;
  const ime = useEmbeddedIme(
    bridge,
    (text) => {
      const input = composerInputRef.current;
      const preeditLength = preeditLengthRef.current;
      const range = composingRangeRef.current;
      const start =
        range?.start ??
        Math.max(0, (input?.selectionStart ?? draftRef.current.length) - preeditLength);
      const end = range?.end ?? Math.max(0, (input?.selectionEnd ?? start) - preeditLength);
      composingRangeRef.current = null;
      const next = `${draftRef.current.slice(0, start)}${text}${draftRef.current.slice(end)}`;
      pendingCaretRef.current = start + text.length;
      draftRef.current = next;
      onDraftChange(next);
    },
    true,
    "chat-composer",
  );
  preeditLengthRef.current = ime.state.preedit.length;
  useLayoutEffect(() => {
    const caret = pendingCaretRef.current;
    const input = composerInputRef.current;
    if (caret === null || !input) return;
    input.setSelectionRange(caret, caret);
    pendingCaretRef.current = null;
  });
  // 内容指纹：消息增减/正文与思维链流式增长都会变化，驱动 MessageStream 自动跟随。
  const contentKey = messages
    .map((message) => `${message.id}:${message.content.length}:${message.reasoning?.length ?? 0}`)
    .join("|");
  return (
    <PanelShell
      context={attachments.length ? "截图已添加，可补充问题" : undefined}
      onClose={onClose}
      title="AI 对话"
      variant="chat"
    >
      <MessageStream ariaLabel="对话消息" contentKey={contentKey} viewportClassName="conversation">
        {messages.map((message) => (
          <article className={`chat-message chat-message--${message.role}`} key={message.id}>
            {message.role === "user" ? (
              <div className="message-content">
                {message.attachments?.map((att) => (
                  <figure className="message-attachment" key={att.id}>
                    <img alt="用户添加的截图" src={att.previewUrl} />
                  </figure>
                ))}
                {message.content}
              </div>
            ) : (
              <AssistantMessage
                caret={
                  Boolean(streaming) &&
                  message.id === messages.at(-1)?.id &&
                  Boolean(message.content)
                }
                content={message.content}
                onFork={onFork}
                onReply={() => composerInputRef.current?.focus()}
                onVote={onVote}
                reasoning={message.reasoning}
                streaming={Boolean(streaming) && message.id === messages.at(-1)?.id}
                thinking={Boolean(streaming && !message.content)}
                thinkingMs={thinkingMs}
              />
            )}
          </article>
        ))}
      </MessageStream>
      <ConversationComposer
        inputLabel="补充问题"
        inputRef={composerInputRef}
        onAddAttachment={() => fileInputRef.current?.click()}
        onPasteImages={(files) => {
          if (files[0]) onAttachmentChange(files[0]);
        }}
        onStop={onCancel}
        onSubmit={onSend}
        onValueChange={onDraftChange}
        placeholder={attachments.length ? "补充问题或说明…" : "输入问题，或先从模式功能添加截图…"}
        streaming={streaming}
        submitDisabled={!draft.trim() && attachments.length === 0}
        value={draft}
        ime={
          ime.available
            ? {
                available: ime.available,
                active: ime.active,
                imeEnabled: ime.imeEnabled,
                state: ime.state,
                onKeyDown: (event) => {
                  if (
                    !ime.state.composing &&
                    (event.key.length === 1 || event.key === "Process") &&
                    !event.ctrlKey &&
                    !event.altKey &&
                    !event.metaKey
                  ) {
                    composingRangeRef.current = {
                      start: event.currentTarget.selectionStart,
                      end: event.currentTarget.selectionEnd,
                    };
                  }
                  return ime.sendKey(event);
                },
                onNavigate: ime.sendNavigation,
                onSelect: ime.select,
                onCandidateUpdate: ime.updateCandidate,
                onFocus: ime.acquire,
                onBlur: ime.blur,
                targetId: "chat-composer",
                generation: ime.generation,
                onToggle: ime.toggle,
              }
            : undefined
        }
      >
        <input
          accept="image/*"
          aria-label="选择截图图片"
          className="file-input-hidden"
          data-ime-policy="excluded"
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
