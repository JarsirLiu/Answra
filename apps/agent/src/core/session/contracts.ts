/** Session/Turn/Step 运行时的内部契约；不包含领域 prompt、工具或持久化实现。 */
import type {
  AgentFinishReason,
  AgentStreamEvent,
  AgentUsage,
  ConversationMessage,
  ManualCompactionResult,
  StepOutcome,
  TurnFinishReason,
  TurnOutcome,
  TurnSource,
  TurnStatus,
} from "@answra/shared/schema";

declare const sessionIdBrand: unique symbol;
declare const turnIdBrand: unique symbol;
declare const stepIdBrand: unique symbol;

export type SessionId = string & { readonly [sessionIdBrand]: true };
export type TurnId = string & { readonly [turnIdBrand]: true };
export type StepId = string & { readonly [stepIdBrand]: true };

/** 只允许运行时和仓储入口创建 branded ID；模型不能提供任意 ID。 */
export function sessionId(value: string): SessionId {
  return requireId(value, "会话 ID") as SessionId;
}

export function turnId(value: string): TurnId {
  return requireId(value, "Turn ID") as TurnId;
}

export function stepId(value: string): StepId {
  return requireId(value, "Step ID") as StepId;
}

/** 每次 Turn 的运行时依赖；只存在内存，不进入条目，也不跨进程持久化。 */
export interface TurnRunContext {
  /** 解析当前 Turn 的模型访问令牌；恢复时必须由宿主重新注入。 */
  getAccessToken: () => Promise<string>;
}

export interface TurnSubmission {
  sessionId: SessionId;
  source: TurnSource;
  agentId: string;
  /** 用户输入；opening/reply 等无新用户消息的 Turn 可以缺省。 */
  input?: ConversationMessage;
  /** 本次提交专属的运行时依赖；不会被写入事件或投影。 */
  runtime: TurnRunContext;
}

export interface TurnSubmissionResult {
  turnId: TurnId;
  /** 当前 Turn 首条 assistant 消息 id；renderer 以此作为 runId 与取消键。 */
  messageId: string;
  /** 0 表示已启动；正整数表示仍在队列中的位置。 */
  position: number;
}

export interface CancelTurnOptions {
  /** 取消活动 Turn 时同时清空 queued Turn；默认保留队列。 */
  cancelQueued?: boolean;
}

export interface TurnStart {
  sessionId: SessionId;
  turnId: TurnId;
  source: TurnSource;
  agentId: string;
  /** 当前 Bot 首条 assistant 消息 id；由宿主注入的工厂生成，Scheduler 写入 turn-started。 */
  messageId: string;
  /** 用户输入；opening/reply 等无新用户消息的 Turn 可以缺省。 */
  input?: ConversationMessage;
}

export interface TurnProjection {
  sessionId: SessionId;
  turnId: TurnId;
  source: TurnSource;
  status: TurnStatus;
  agentId: string;
  activeAgentId?: string;
  input?: ConversationMessage;
  assistantMessageIds: readonly string[];
  handoffCount: number;
  finishReason?: TurnFinishReason;
  errorText?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface StepProjection {
  stepId: StepId;
  sessionId: SessionId;
  turnId: TurnId;
  messageId?: string;
  index: number;
  agentId?: string;
  modelId?: string;
  status: "running" | StepOutcome;
  finishReason?: string;
  usage?: AgentUsage;
  errorText?: string;
  startedAt: string;
  finishedAt?: string;
}

/** 运行状态只存在内存；重启后从条目还原 Turn 与待续跑队列。 */
export interface SessionProjection {
  sessionId: SessionId;
  /** 会话已写入的最后一个条目 `seq`。 */
  sequence: number;
  turns: readonly TurnProjection[];
  queue: readonly TurnId[];
  activeTurnId?: TurnId;
}

/** 崩溃恢复只补写缺失的收口条目，并把可续跑的 Turn 交回 Scheduler。 */
export interface SessionRecoveryPlan {
  closedTurnIds: readonly TurnId[];
  pendingTurnIds: readonly TurnId[];
}

export interface TurnFinish {
  turnId: TurnId;
  outcome: TurnOutcome;
  reason?: TurnFinishReason;
  errorText?: string;
  /** 本轮执行过的 step 数；由 TurnExecutor 统计，turn-end 直接落库。 */
  steps?: number;
  /** 最后一步 provider 的终因与用量；没有 step 时缺省。 */
  finishReason?: AgentFinishReason;
  usage?: AgentUsage;
  durationMs?: number;
}

/** 当前 Bot 在 step 正常结束后请求交接；交接不是新 Turn。 */
export interface TurnHandoff {
  toAgentId: string;
  task: string;
}

/**
 * 目标 Bot 的交接输入事实；上一位 Bot 的回复正文由 transcript 按
 * `sourceMessageId` 提供，不在 StepStart 中复制。
 */
export interface StepHandoff {
  fromAgentId: string;
  task: string;
  sourceMessageId: string;
}

/** StepRunner 只能写模型流事件；step-* 与 usage 由 SessionStepExecutor 独占。 */
export interface StepEventSink {
  /** live-only 增量由宿主实时消费；实现只持久化结算条目。 */
  append(event: AgentStreamEvent): Promise<void>;
  /** 等待已排队的条目写入；live-only 增量不在此等待。 */
  flush(): Promise<void>;
}

/** Step 事件漏斗：实现必须先写内存视图，再按需落条目；不改变 Turn 状态。 */
export interface StepEventRecorder {
  append(step: StepStart, event: AgentStreamEvent): Promise<void>;
}

/** Bot→Bot 交接的写入输入；消息 id 由 TurnExecutor 分配。 */
export interface StoredHandoff {
  turnId: TurnId;
  fromAgentId: string;
  toAgentId: string;
  task: string;
  /** 交接前最后一条 assistant 消息 id。 */
  sourceMessageId: string;
  /** 交接目标 Bot 的新 assistant 消息 id。 */
  nextMessageId: string;
}

/** Scheduler/TurnExecutor 唯一的事实写入面；实现负责条目、内存视图与帧广播。 */
export interface TurnRecorder {
  /** 提交即写 user 条目；此时不进入内存视图，也不置 open_turn_id。 */
  recordUserMessage(
    sessionId: SessionId,
    message: ConversationMessage,
    turnId: TurnId,
  ): Promise<void>;
  /** Turn 真正开始：内存占位 + 置 open_turn_id。 */
  beginTurn(sessionId: SessionId, turn: TurnStart): Promise<void>;
  /** 收口 Turn：补未结算 part、写 turn-end、清 open_turn_id。 */
  finishTurn(sessionId: SessionId, turnId: TurnId, finish: TurnFinish): Promise<void>;
  /** 排队 Turn 被取消：只写 turn-end{interrupted, cancelled}。 */
  cancelQueuedTurn(sessionId: SessionId, turn: TurnStart): Promise<void>;
  recordHandoff(sessionId: SessionId, handoff: StoredHandoff): Promise<void>;
  /** 已写入的最后一条条目 `seq`；Scheduler 用它推进快照游标。 */
  lastSeq(sessionId: SessionId): Promise<number>;
}

/** StepRunner 的运行时上下文；目标 Bot 的 prompt 由领域适配器按 agentId 解析。 */
export interface StepRunContext {
  events: StepEventSink;
  /** 当前 Turn 的运行时依赖；同一 Turn 的所有 step 共享，不落条目。 */
  runtime: TurnRunContext;
}

/** 一次 provider 请求及其工具执行的输入；不包含领域 prompt 或工具实现。 */
export interface StepStart {
  sessionId: SessionId;
  turnId: TurnId;
  stepId: StepId;
  index: number;
  agentId: string;
  /** Turn 的提交来源；领域用它区分 opening 与 reply，不从消息或运行状态推演。 */
  source: TurnSource;
  modelId?: string;
  /** 当前 Bot 回复的 assistant 消息 id；同一 Bot 的多个 step 复用。 */
  messageId: string;
  /** Turn 的用户输入；无用户消息的 Turn 可以缺省。StepRunner 用它构建领域输入。 */
  input?: ConversationMessage;
  /** 同一目标 Bot 的所有 step 共享同一份交接输入。 */
  handoff?: StepHandoff;
}

/** StepExecutor 的完成结果；handoff 只由 TurnExecutor 消费。 */
export interface StepResult {
  stepId: StepId;
  outcome: StepOutcome;
  finishReason?: AgentFinishReason;
  usage?: AgentUsage;
  errorText?: string;
  handoff?: TurnHandoff;
}

/** 一次 provider 请求与工具执行的端口；独占 step-* 与 usage，模型流事件经 StepEventSink 写入，不能改 Turn 状态。 */
export interface StepExecutor {
  run(step: StepStart, runtime: TurnRunContext, signal: AbortSignal): Promise<StepResult>;
}

/**
 * 单次 provider 请求的输入 token。
 *
 * 一个 session step 内部可能有多次 AI SDK 请求（工具循环），`usage` 是这些请求的**总和**，
 * 不能当上下文占用：首个请求用于校准估算锚点，最后一个请求才是当前上下文大小。
 */
export interface StepRequestTokens {
  firstInputTokens?: number;
  lastInputTokens?: number;
}

/**
 * 真实 provider/工具执行器返回的事实；step 事件由 SessionStepExecutor 统一写。
 * handoff 目标必须由宿主在返回前校验可见性；TurnExecutor 只做非空与自交接校验。
 */
export interface StepRunnerResult {
  outcome: StepOutcome;
  finishReason?: AgentFinishReason;
  usage?: AgentUsage;
  /** provider 逐请求的输入量；缺失表示这条链路没有报告，不推演。 */
  requestTokens?: StepRequestTokens;
  errorText?: string;
  handoff?: TurnHandoff;
}

export interface StepRunner {
  run(step: StepStart, context: StepRunContext, signal: AbortSignal): Promise<StepRunnerResult>;
}

/** 一轮问答的执行端口；终态由 Scheduler 写入，执行器只返回结果。 */
export interface TurnExecutor {
  run(turn: TurnStart, runtime: TurnRunContext, signal: AbortSignal): Promise<TurnFinish>;
}

export interface SessionCompactionRequest {
  sessionId: SessionId;
  operationId: string;
  instructions?: string;
}

/** 手动压缩的执行端口；事件与 checkpoint 由实现写入，Scheduler 只排序。 */
export interface SessionCompactor {
  compact(request: SessionCompactionRequest, signal: AbortSignal): Promise<ManualCompactionResult>;
}

function requireId(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 不能为空`);
  return value;
}
