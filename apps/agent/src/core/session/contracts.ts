/** Session/Turn/Step 运行时的内部契约；不包含领域 prompt、工具或持久化实现。 */
import type {
  AgentFinishReason,
  AgentStreamEvent,
  AgentUsage,
  CompactionReason,
  ContextCompactionState,
  ContextCompactionTrigger,
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

/** 每次 Turn 的运行时依赖；只存在内存，不进入 journal，也不跨进程持久化。 */
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

export interface CompactionProjection {
  operationId: string;
  trigger: ContextCompactionTrigger;
  reason?: CompactionReason;
  state: ContextCompactionState;
  summarizedMessages?: number;
  summary?: string;
  usage?: AgentUsage;
  startedAt: string;
  finishedAt?: string;
  errorText?: string;
}

export interface ContextUsageProjection {
  usedTokens: number;
  updatedAt: string;
}

export interface SessionProjection {
  sessionId: SessionId;
  sequence: number;
  turns: readonly TurnProjection[];
  queue: readonly TurnId[];
  activeTurnId?: TurnId;
  steps: readonly StepProjection[];
  compactions: readonly CompactionProjection[];
  contextUsage?: ContextUsageProjection;
}

export interface SessionRecoveryPlan {
  projection: SessionProjection;
  interruptedTurnIds: readonly TurnId[];
  interruptedStepIds: readonly StepId[];
  interruptedCompactionIds: readonly string[];
}

export interface TurnFinish {
  turnId: TurnId;
  outcome: TurnOutcome;
  reason?: TurnFinishReason;
  errorText?: string;
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
  /** live-only 增量由宿主实时消费；journal 实现只持久化 durable 事件。 */
  append(event: AgentStreamEvent): Promise<void>;
  /** 等待已排队的 durable 事件写入 journal；live-only 增量不在此等待。 */
  flush(): Promise<void>;
}

/** StepRunner 的运行时上下文；目标 Bot 的 prompt 由领域适配器按 agentId 解析。 */
export interface StepRunContext {
  events: StepEventSink;
  /** 当前 Turn 的运行时依赖；同一 Turn 的所有 step 共享，不落 journal。 */
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
 * 真实 provider/工具执行器返回的事实；step 事件由 SessionStepExecutor 统一写。
 * handoff 目标必须由宿主在返回前校验可见性；TurnExecutor 只做非空与自交接校验。
 */
export interface StepRunnerResult {
  outcome: StepOutcome;
  finishReason?: AgentFinishReason;
  usage?: AgentUsage;
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
