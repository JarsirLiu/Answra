import type { DesktopBridge } from "@answra/shared";
import { X } from "lucide-react";
import { type RefObject, useRef } from "react";
import { useControlledImeTextAdapter } from "../../ime/adapters/useControlledImeTextAdapter";
import { ICON_SM } from "../../tokens";
import { AssistantMessage, MessageStream, ModelErrorNotice } from "../chat";
import { ConversationComposer } from "./ConversationComposer";
import { PanelShell } from "./PanelShell";
import "../chat/conversation.css";
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
  /**
   * 模型调用失败的提示，直接显示在对话正文末尾（未登录时是统一的登录提示）。
   * 发送失败属于本轮对话的结果，不再另弹浮层横条。
   */
  error?: string;
  /**
   * 传了才在提示里出现「去登录」按钮：仅在 `error` 确定是「需要登录」时传入。
   * 登录动作由调用方执行，面板本身不认识账号体系。
   */
  onSignIn?: () => void;
  /** 分叉对话：从当前消息开启新对话。 */
  onFork?: () => void;
  /** 点赞/点踩反馈。 */
  onVote?: (vote: "up" | "down" | null) => void;
  /** 清空对话历史（经网关链路归零，所有订阅方同步）；缺省不显示清空入口。 */
  onClear?: () => void;
  /** 清空不可用的原因（活动回复进行中/没有消息）；设置即禁用按钮并以 title 提示。 */
  clearDisabledReason?: string;
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
  error,
  onSignIn,
  onFork,
  onVote,
  onClear,
  clearDisabledReason,
  onClose,
  bridge,
}: ChatPanelProps) {
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const controlledImeText = useControlledImeTextAdapter({
    inputRef: composerInputRef,
    value: draft,
    onChange: onDraftChange,
  });
  const ime = useEmbeddedIme(bridge, controlledImeText.commit, true, "chat-composer");
  // 内容指纹：消息增减/正文与思维链流式增长都会变化，驱动 MessageStream 自动跟随；
  // 失败提示也算本轮结果，出现时要能滚到可见位置。
  const contentKey = [
    ...messages.map(
      (message) => `${message.id}:${message.content.length}:${message.reasoning?.length ?? 0}`,
    ),
    error ? `error:${error}` : "",
  ].join("|");
  return (
    <PanelShell
      context={attachments.length ? "截图已添加，可补充问题" : undefined}
      headerAction={
        onClear ? (
          <button
            aria-label="清空对话"
            className="panel-header-action surface-control surface-control--quiet"
            disabled={Boolean(clearDisabledReason)}
            onClick={onClear}
            title={clearDisabledReason ?? "清空对话历史"}
            type="button"
          >
            清空
          </button>
        ) : undefined
      }
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
        {error && <ModelErrorNotice message={error} onSignIn={onSignIn} />}
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
        ime={ime.available ? { session: ime, composition: controlledImeText } : undefined}
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
