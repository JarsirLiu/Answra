/** 跨领域 transcript 仓储端口；只定义消息与恢复游标，不绑定具体存储实现。 */
import type { ConversationMessage, ConversationSnapshot } from "@answra/shared";
import type { AgentEventEnvelope } from "@answra/shared/schema";

/**
 * Conversation、Answer 与 Interview 共用的 transcript 仓储端口。
 * 约束会话消息、活动回合认领和事件恢复游标；不指定内存或磁盘实现。
 */
export interface ConversationStore {
  create(conversationId: string): Promise<ConversationSnapshot>;
  /**
   * 仅空闲清理：会话没有活动 run 时才清空消息；仍有活动 run 时 no-op。
   * 清空并记录覆盖到的事件 revision；UI 由发起操作的一方清理本地投影。
   */
  clear(conversationId: string, eventRevision?: number): Promise<void>;
  load(conversationId: string): Promise<ConversationSnapshot>;
  beginRun(
    conversationId: string,
    runId: string,
    userMessage: ConversationMessage,
    eventRevision?: number,
  ): Promise<void>;
  /** 认领最后一条用户消息并追加 assistant 占位；不存在可回复消息或已有活动 run 时不写入。 */
  beginReplyRun(
    conversationId: string,
    runId: string,
    eventRevision?: number,
  ): Promise<ConversationMessage>;
  appendUserMessage(
    conversationId: string,
    userMessage: ConversationMessage,
  ): Promise<ConversationSnapshot>;
  /** 一次性答题的检查、清理和消息对安装必须保持为同一原子迁移。 */
  beginEphemeralRun(
    conversationId: string,
    runId: string,
    userMessage: ConversationMessage,
    eventRevision?: number,
  ): Promise<void>;
  /** Consume the canonical event envelope to update recoverable message content and status. */
  applyAgentEvent(conversationId: string, envelope: AgentEventEnvelope): Promise<void>;
}
