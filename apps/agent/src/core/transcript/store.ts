/** 跨领域 transcript 仓储端口；只定义消息与会话元数据，不绑定具体存储实现。 */
import type { ConversationBot, ConversationMessage, ConversationSnapshot } from "@answra/shared";
import type { AgentEventEnvelope } from "@answra/shared/schema";

/** Team metadata attached to a conversation; identities stay in the Agent registry. */
export interface ConversationSessionSeed {
  activeAgentId: string;
  participantAgentIds: readonly string[];
  bots?: readonly ConversationBot[];
}

export interface HandoffMessageInput {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  task: string;
}

/**
 * Conversation、Answer 与 Interview 共用的 transcript 仓储端口。
 * 约束会话消息、活动回合认领、Bot 归属和事件恢复游标；不指定内存或磁盘实现。
 */
export interface ConversationStore {
  create(conversationId: string, seed?: ConversationSessionSeed): Promise<ConversationSnapshot>;
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
    authorAgentId?: string,
  ): Promise<void>;
  /** 认领最后一条用户消息并追加 assistant 占位；不存在可回复消息或已有活动 run 时不写入。 */
  beginReplyRun(
    conversationId: string,
    runId: string,
    eventRevision?: number,
    authorAgentId?: string,
  ): Promise<ConversationMessage>;
  /** 认领发给 targetAgentId 的交接记录并追加目标 Bot 的 assistant 占位。 */
  beginHandoffRun(
    conversationId: string,
    runId: string,
    targetAgentId: string,
    eventRevision?: number,
  ): Promise<ConversationMessage>;
  /** 写入一条已完成的 Bot→Bot 交接记录；不产生事件，不推进 revision。 */
  appendHandoffMessage(
    conversationId: string,
    handoff: HandoffMessageInput,
  ): Promise<ConversationSnapshot>;
  /** 交接写入后的会话归属转移；不产生事件，不推进 revision。 */
  setActiveAgent(conversationId: string, agentId: string): Promise<void>;
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
    authorAgentId?: string,
  ): Promise<void>;
  /** Consume the canonical event envelope to update recoverable message content and status. */
  applyAgentEvent(conversationId: string, envelope: AgentEventEnvelope): Promise<void>;
}
