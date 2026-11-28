/** 跨领域 transcript 仓储端口；只定义消息与会话元数据，不绑定具体存储实现。 */
import type {
  ConversationBot,
  ConversationMessage,
  ConversationSessionScope,
  ConversationSnapshot,
} from "@answra/shared";
import type { AgentStreamEvent, TurnOutcome, TurnSource } from "@answra/shared/schema";
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
  | { kind: "cleared" };

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
  /**
   * Turn 提交来源；store 只用它区分「开场」和「回复」。
   * 开场可以没有用户消息（即使已有历史），回复必须有可回复的用户消息。
   */
  source?: TurnSource;
  /**
   * 用户消息已由条目折进 transcript 时，把 assistant 占位插到它后面而不是追加到末尾。
   * 多个排队 Turn 恢复时，后面 Turn 的消息已经存在，追加会打乱顺序。
   */
  afterMessageId?: string;
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
   * 清空即重置：调用方负责同时清空条目。
   */
  clear(conversationId: string): Promise<void>;
  /**
   * 单调推进 snapshot 的 durable 游标；只由条目写入在落库后调用。
   * 小于等于当前游标的写入是同一条事实的重复写入，直接忽略。
   */
  advanceLastSeq(conversationId: string, sequence: number): Promise<void>;
  /**
   * 用条目重建内存消息视图，并保留仍在流式的活动消息。
   *
   * 磁盘实现启动时先折条目再删掉旧行；恢复收口后调用一次，避免内存里留着
   * 「没有 turn-end」的半截消息。内存实现本身就是事实来源，只是 no-op。
   */
  refresh(conversationId: string): Promise<void>;
  load(conversationId: string): Promise<ConversationSnapshot>;
  /** 新 Session 运行时：在 turn 开始时安装 user 消息与首条 assistant 占位。 */
  beginSessionTurn(conversationId: string, input: SessionTurnStartInput): Promise<void>;
  /** 新 Session 运行时：为交接目标 Bot 追加 assistant 占位。 */
  beginSessionAssistant(
    conversationId: string,
    messageId: string,
    authorAgentId: string,
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
  ): Promise<void>;
  /** 新 Session 运行时：Turn 结束时清空活动 Turn 与活动消息；不属于该 Turn 时 no-op。 */
  finishSessionTurn(conversationId: string, turnId: string): Promise<void>;
  /** 写入一条已完成的 Bot→Bot 交接记录。 */
  appendHandoffMessage(
    conversationId: string,
    handoff: HandoffMessageInput,
  ): Promise<ConversationSnapshot>;
  /** 交接写入后的会话归属转移。 */
  setActiveAgent(conversationId: string, agentId: string): Promise<void>;
  appendUserMessage(
    conversationId: string,
    userMessage: ConversationMessage,
  ): Promise<ConversationSnapshot>;
  /** 读取上下文检查点与压缩生命周期；与 transcript 消息分开保存，避免 UI snapshot 携带摘要正文。 */
  loadContextState(conversationId: string): Promise<ContextState | undefined>;
  saveContextState(conversationId: string, state: ContextState): Promise<void>;
  /** 宿主退出时收口待写入内容；可重复调用。 */
  close(): Promise<void>;
}
