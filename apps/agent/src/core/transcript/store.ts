/** 跨领域 transcript 仓储端口；只定义消息与会话元数据，不绑定具体存储实现。 */
import type {
  ConversationBot,
  ConversationMessage,
  ConversationSessionScope,
  ConversationSnapshot,
} from "@answra/shared";
import type { AgentEventEnvelope, AgentStreamEvent, TurnOutcome } from "@answra/shared/schema";
import type { ContextState } from "./contextState";

/** Team metadata attached to a conversation; identities stay in the Agent registry. */
export interface ConversationSessionSeed {
  activeAgentId: string;
  participantAgentIds: readonly string[];
  bots?: readonly ConversationBot[];
}

/** 宿主写入的会话分类；不进入消息正文，也不由 conversationId 前缀推断。 */
export interface ConversationSessionMetadata {
  scope: ConversationSessionScope;
  workspaceRoot?: string;
  title?: string;
}

export type ConversationStoreMutation =
  | {
      kind: "created" | "changed" | "run-started" | "run-finished";
      dirtyMessageIds?: readonly string[];
    }
  | { kind: "stream-checkpoint"; messageId: string }
  | { kind: "cleared" }
  | { kind: "event"; event: AgentEventEnvelope };

/** 清空会话时要写回 snapshot 的旧 wire 游标；durable 游标固定归零。 */
export interface ConversationClearCursor {
  /** 聚合 revision；P2 第 3 步随 envelope 一起删除。 */
  eventRevision?: number;
}

export interface HandoffMessageInput {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  task: string;
}

/** 新 Session 运行时在 turn 开始时安装 transcript 消息所需的最小事实。 */
export interface SessionTurnStartInput {
  turnId: string;
  messageId: string;
  authorAgentId: string;
  /** 无新用户消息的 opening/reply Turn 可以缺省。 */
  userMessage?: ConversationMessage;
  eventRevision?: number;
}

/**
 * Conversation、Answer 与 Interview 共用的 transcript 仓储端口。
 * 约束会话消息、活动回合认领、Bot 归属和事件恢复游标；不指定内存或磁盘实现。
 */
export interface ConversationStore {
  create(
    conversationId: string,
    seed?: ConversationSessionSeed,
    metadata?: ConversationSessionMetadata,
  ): Promise<ConversationSnapshot>;
  /** 会话所属产品面；不存在时返回 undefined。跨领域 replay 不允许在错误领域执行恢复。 */
  scopeOf(conversationId: string): Promise<ConversationSessionScope | undefined>;
  /**
   * 仅空闲清理：会话没有活动 run 时才清空消息；仍有活动 run 时 no-op。
   * 清空即重置：durable 游标归零，调用方负责同时清空 journal。
   */
  clear(conversationId: string, cursor?: ConversationClearCursor): Promise<void>;
  /**
   * 单调推进 snapshot 的 durable 游标；只由 Session 桥接在 transcript 写回后调用。
   * 小于等于当前游标的写入是同一条事实的重复投影，直接忽略。
   */
  advanceLastSeq(conversationId: string, sequence: number): Promise<void>;
  load(conversationId: string): Promise<ConversationSnapshot>;
  beginRun(
    conversationId: string,
    runId: string,
    userMessage: ConversationMessage,
    eventRevision?: number,
    authorAgentId?: string,
    /** Session 路径写入活动 Turn；Answer 的旧 run 路径不传。 */
    turnId?: string,
  ): Promise<void>;
  /** 认领最后一条用户消息并追加 assistant 占位；不存在可回复消息或已有活动回复时不写入。 */
  beginReplyRun(
    conversationId: string,
    runId: string,
    eventRevision?: number,
    authorAgentId?: string,
    turnId?: string,
  ): Promise<ConversationMessage>;
  /** 追加一次无 user 消息的开场 assistant 占位；已有活动回复时拒绝。 */
  beginOpeningRun(
    conversationId: string,
    runId: string,
    eventRevision?: number,
    authorAgentId?: string,
    turnId?: string,
  ): Promise<void>;
  /** 认领发给 targetAgentId 的交接记录并追加目标 Bot 的 assistant 占位。 */
  beginHandoffRun(
    conversationId: string,
    runId: string,
    targetAgentId: string,
    eventRevision?: number,
  ): Promise<ConversationMessage>;
  /** 新 Session 运行时：在 turn 开始时安装 user 消息与首条 assistant 占位。 */
  beginSessionTurn(conversationId: string, input: SessionTurnStartInput): Promise<void>;
  /** 新 Session 运行时：为交接目标 Bot 追加 assistant 占位。 */
  beginSessionAssistant(
    conversationId: string,
    messageId: string,
    authorAgentId: string,
    eventRevision?: number,
  ): Promise<void>;
  /** 新 Session 运行时：按 assistant messageId 写回模型流事件，不依赖旧 runId。 */
  applySessionStreamEvent(
    conversationId: string,
    messageId: string,
    event: AgentStreamEvent,
  ): Promise<void>;
  /** 新 Session 运行时：收口指定 assistant 消息。 */
  finishSessionAssistant(
    conversationId: string,
    messageId: string,
    outcome: TurnOutcome,
    eventRevision?: number,
  ): Promise<void>;
  /** 新 Session 运行时：Turn 结束时清空活动 Turn 与活动消息；不属于该 Turn 时 no-op。 */
  finishSessionTurn(conversationId: string, turnId: string): Promise<void>;
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
  /** 读取上下文检查点与压缩生命周期；与 transcript 消息分开保存，避免 UI snapshot 携带摘要正文。 */
  loadContextState(conversationId: string): Promise<ContextState | undefined>;
  saveContextState(conversationId: string, state: ContextState): Promise<void>;
  /** 宿主退出时收口待写入内容；可重复调用。 */
  close(): Promise<void>;
}
