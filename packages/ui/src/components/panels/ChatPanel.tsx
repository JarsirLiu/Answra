import type {
  AgentConnectionState,
  ContextCompactionBoundary,
  ContextCompactionStatus,
  ContextPruningStatus,
  ContextUsage,
  DesktopBridge,
} from "@answra/shared";
import { MANUAL_COMPACTION_INSTRUCTIONS_MAX_CHARS } from "@answra/shared";
import { LoaderCircle, X } from "lucide-react";
import { type FormEvent, type RefObject, useId, useRef, useState } from "react";
import { ICON_SM } from "../../tokens";
import {
  AssistantMessage,
  CompactionBoundaryCard,
  ConnectionNotice,
  ContextCompactionNotice,
  ContextPruningNotice,
  ContextUsageNotice,
  formatConnectionNotice,
  MessageStream,
  ModelErrorNotice,
  RetryNotice,
} from "../chat";
import { mergeCompactionBoundaries } from "../chat/compactionBoundaries";
import {
  type ConversationRetry,
  type ConversationViewMessage,
  partsContentKey,
} from "../chat/conversationMessage";
import { SurfaceButton } from "../controls/SurfaceButton";
import { ConversationComposer } from "./ConversationComposer";
import { PanelShell } from "./PanelShell";
import "../chat/conversation.css";
import "./ChatPanel.css";

export interface ChatAttachment {
  id: string;
  name: string;
  previewUrl: string;
}

interface ChatPanelProps {
  messages: ConversationViewMessage[];
  draft: string;
  attachments: ChatAttachment[];
  fileInputRef: RefObject<HTMLInputElement | null>;
  onDraftChange: (value: string) => void;
  onAttachmentChange: (file: File | null) => void;
  onAttachmentRemove: (id: string) => void;
  onSend: () => void;
  onCancel: () => void;
  streaming: boolean;
  /** IPC 正在接收本轮模型运行；此时还没有可取消的 run。 */
  sending?: boolean;
  /** 本轮模型调用正在指数退避重试；同一条消息内原地更新。 */
  retry?: ConversationRetry;
  /** Agent worker 链路状态；与模型重试/错误互斥展示。 */
  connection?: AgentConnectionState;
  /** 上下文摘要压缩生命周期；独立于模型 run 状态。 */
  contextCompaction?: ContextCompactionStatus;
  /** 已成功摘要的边界；按 throughMessageId 插入消息流。 */
  compactionBoundaries?: readonly ContextCompactionBoundary[];
  /** 手动压缩的即时反馈；成功结果仍以 snapshot 状态展示。 */
  compactNotice?: string;
  /** 最近一次模型请求的上下文占用与阈值。 */
  contextUsage?: ContextUsage;
  /** 最近一次实际应用的旧工具结果清理。 */
  contextPruning?: ContextPruningStatus;
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
  /** 手动压缩上下文；可附带一次性摘要指令，缺省不显示压缩入口。 */
  onCompact?: (instructions?: string) => void;
  /** 手动压缩不可用的原因；设置即禁用按钮并用 title 提示。 */
  compactDisabledReason?: string;
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
  sending = false,
  retry,
  connection,
  contextCompaction,
  compactionBoundaries,
  compactNotice,
  contextUsage,
  contextPruning,
  thinkingMs,
  error,
  onSignIn,
  onFork,
  onVote,
  onClear,
  clearDisabledReason,
  onCompact,
  compactDisabledReason,
  onClose,
  bridge: _bridge,
  stealth: _stealth,
}: ChatPanelProps) {
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const compactInputId = useId();
  const [compactFormOpen, setCompactFormOpen] = useState(false);
  const [compactInstructions, setCompactInstructions] = useState("");
  const connectionNotice = formatConnectionNotice(connection);
  const timeline = mergeCompactionBoundaries(messages, compactionBoundaries);

  function closeCompactForm(): void {
    setCompactFormOpen(false);
    setCompactInstructions("");
  }

  function submitCompaction(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const instructions = compactInstructions.trim();
    closeCompactForm();
    onCompact?.(instructions || undefined);
  }
  // 内容指纹：消息增减/正文与思维链流式增长都会变化，驱动 MessageStream 自动跟随；
  // 失败提示也算本轮结果，出现时要能滚到可见位置。
  const contentKey = [
    ...messages.map(
      (message) =>
        `${message.id}:${message.text.length}:${message.reasoning?.length ?? 0}:${partsContentKey(message.parts)}`,
    ),
    retry ? `retry:${retry.attempt}/${retry.maxRetries}` : "",
    error ? `error:${error}` : "",
    connection ? `connection:${connection.revision}` : "",
    contextCompaction ? `compaction:${contextCompaction.state}:${contextCompaction.updatedAt}` : "",
    ...(compactionBoundaries ?? []).map(
      (boundary) =>
        `boundary:${boundary.id}:${boundary.summary.length}:${boundary.instructions?.length ?? 0}`,
    ),
    contextUsage ? `usage:${contextUsage.usedTokens}:${contextUsage.updatedAt}` : "",
    contextPruning ? `pruning:${contextPruning.updatedAt}` : "",
  ].join("|");
  return (
    <PanelShell
      context={attachments.length ? "截图已添加，可补充问题" : undefined}
      headerAction={
        onClear || onCompact ? (
          <div className="panel-header-action chat-panel-header-actions">
            {onCompact && (
              <SurfaceButton
                aria-label={compactDisabledReason ?? "压缩上下文"}
                disabled={Boolean(compactDisabledReason)}
                onClick={() => setCompactFormOpen(true)}
                variant="quiet"
              >
                压缩
              </SurfaceButton>
            )}
            {onClear && (
              <SurfaceButton
                aria-label={clearDisabledReason ?? "清空对话历史"}
                disabled={Boolean(clearDisabledReason)}
                onClick={onClear}
                variant="quiet"
              >
                清空
              </SurfaceButton>
            )}
          </div>
        ) : undefined
      }
      onClose={onClose}
      title="AI 对话"
      variant="chat"
    >
      {compactFormOpen && onCompact ? (
        <form className="chat-panel-compact-form" onSubmit={submitCompaction}>
          <label className="chat-panel-compact-label" htmlFor={compactInputId}>
            摘要指令（可选）
          </label>
          <textarea
            id={compactInputId}
            maxLength={MANUAL_COMPACTION_INSTRUCTIONS_MAX_CHARS}
            onChange={(event) => setCompactInstructions(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") closeCompactForm();
            }}
            placeholder="告诉摘要重点保留什么，例如：保留数据库迁移决定和未完成事项。"
            rows={2}
            value={compactInstructions}
          />
          <div className="chat-panel-compact-actions">
            <span className="chat-panel-compact-count">
              {compactInstructions.length}/{MANUAL_COMPACTION_INSTRUCTIONS_MAX_CHARS}
            </span>
            <SurfaceButton onClick={closeCompactForm} size="sm" variant="quiet">
              取消
            </SurfaceButton>
            <SurfaceButton size="sm" type="submit">
              开始压缩
            </SurfaceButton>
          </div>
        </form>
      ) : null}
      <MessageStream
        ariaLabel="对话消息"
        contentKey={contentKey}
        viewportClassName="conversation conversation--chat"
      >
        {timeline.map((item) => {
          if (item.kind === "compaction") {
            return <CompactionBoundaryCard boundary={item.boundary} key={item.id} />;
          }
          const message = item.message;
          return (
            <article className={`chat-message chat-message--${message.role}`} key={item.id}>
              {message.role === "user" ? (
                <div className="message-content">
                  {message.images?.map((image, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: 持久化消息只带图片内容，没有稳定 id
                    <figure className="message-attachment" key={`${message.id}-${index}`}>
                      <img alt="用户添加的截图" src={image.dataUrl} />
                    </figure>
                  ))}
                  {message.text}
                </div>
              ) : (
                <>
                  {message.waitingForStream && (
                    <div aria-label="回复运行中" className="conversation-running" role="status">
                      <LoaderCircle
                        aria-hidden="true"
                        className="conversation-running-icon"
                        size={15}
                      />
                    </div>
                  )}
                  <AssistantMessage
                    caret={
                      message.status === "streaming" &&
                      message.id === messages.at(-1)?.id &&
                      Boolean(message.text)
                    }
                    content={message.text}
                    onFork={onFork}
                    onReply={() => {
                      composerInputRef.current?.focus();
                    }}
                    onVote={onVote}
                    parts={message.parts}
                    reasoning={message.reasoning}
                    streaming={message.status === "streaming" && message.id === messages.at(-1)?.id}
                    thinking={message.thinking === true}
                    thinkingMs={thinkingMs}
                  />
                </>
              )}
            </article>
          );
        })}
        {compactNotice && (
          <div className="chat-panel-compact-notice" role="status">
            {compactNotice}
          </div>
        )}
        {contextCompaction && <ContextCompactionNotice status={contextCompaction} />}
        {contextPruning && <ContextPruningNotice status={contextPruning} />}
        {contextUsage && <ContextUsageNotice usage={contextUsage} />}
        <ConnectionNotice state={connection} />
        {!connectionNotice && retry && <RetryNotice retry={retry} />}
        {!connectionNotice && error && <ModelErrorNotice message={error} onSignIn={onSignIn} />}
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
        disabled={sending}
        submitDisabled={!draft.trim() && attachments.length === 0}
        value={draft}
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
