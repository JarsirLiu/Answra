import { z } from "zod";

/** Runtime status vocabulary used by the canonical Agent event flow and transcript. */
export const agentRetrySchema = z.strictObject({
  kind: z.enum(["rate-limit", "server-error", "network-error"]),
  attempt: z.number().int().positive(),
  maxRetries: z.number().int().positive(),
  delayMs: z.number().int().nonnegative(),
  statusCode: z.number().int().positive().optional(),
});
export const agentRetryWaitSchema = agentRetrySchema.extend({
  scheduledAt: z.string().datetime(),
});
export const agentRunStateSchema = z.enum([
  "queued",
  "claimed",
  "running",
  "retry-wait",
  "completed",
  "failed",
  "aborted",
  "superseded",
  "orphaned",
]);
export const runOutcomeSchema = z.enum(["completed", "failed", "aborted", "superseded"]);
/** 用户可见的 turn 生命周期；step 活动、压缩和重试都不是 turn 状态。 */
export const turnStatusSchema = z.enum(["queued", "running", "completed", "failed", "aborted"]);
/** Turn/Step 共用的终态词汇；`queued`/`running` 只存在于活动投影。 */
export const turnOutcomeSchema = z.enum(["completed", "failed", "aborted"]);
/** Step 终态复用同一组词汇，禁止再定义第二份 completed/failed/aborted。 */
export const stepOutcomeSchema = turnOutcomeSchema;
/** Turn 输入来源；handoff 是同一 Turn 内的事件，不是新 Turn 来源。 */
export const turnSourceSchema = z.enum(["user", "reply", "opening", "worker", "external"]);
/** Turn 终态原因；失败原因必须可观察，不能只靠自由文本。 */
export const turnFinishReasonSchema = z.enum([
  "completed",
  "interrupted",
  "handoff-failed",
  "context-exhausted",
  "model-error",
  "tool-error",
  "cancelled",
  "unknown",
]);
/** 压缩触发原因；自动阈值与 provider 溢出恢复必须区分。 */
export const compactionReasonSchema = z.enum(["threshold", "provider-overflow", "manual"]);
/** Lifecycle of a model-requested tool call. */
export const agentToolCallStateSchema = z.enum([
  "input-streaming",
  "pending",
  "awaiting-approval",
  "running",
  "completed",
  "failed",
  "interrupted",
  "denied",
]);
/** Lifecycle of a transcript message. */
export const agentMessageStateSchema = z.enum(["streaming", "complete", "failed", "interrupted"]);
/** Lifecycle of a text, reasoning, or tool content part. */
export const agentPartStateSchema = z.enum([
  "started",
  "streaming",
  "completed",
  "failed",
  "interrupted",
]);
export const agentPartKindSchema = z.enum(["text", "reasoning", "tool", "source", "file", "data"]);
export const agentFinishReasonSchema = z.enum([
  "stop",
  "length",
  "content-filter",
  "tool-calls",
  "error",
  "other",
]);
export const agentUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  inputTokenDetails: z
    .strictObject({
      noCacheTokens: z.number().int().nonnegative().optional(),
      cacheReadTokens: z.number().int().nonnegative().optional(),
      cacheWriteTokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
  outputTokenDetails: z
    .strictObject({
      textTokens: z.number().int().nonnegative().optional(),
      reasoningTokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});
/** 上下文摘要压缩的独立生命周期；不复用 Agent run 状态。 */
export const contextCompactionStateSchema = z.enum([
  "idle",
  "started",
  "failed",
  "succeeded",
  "aborted",
]);
export const contextCompactionTriggerSchema = z.enum(["auto", "manual"]);
export const contextCompactionSchema = z.strictObject({
  state: contextCompactionStateSchema,
  trigger: contextCompactionTriggerSchema,
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  /** 本次摘要覆盖的消息数；成功时写入，便于 UI 解释压缩范围。 */
  summarizedMessages: z.number().int().nonnegative().optional(),
  errorText: z.string().optional(),
});
/** 手动压缩指令的一次性输入上限；超出时在 IPC/Agent 入口 fail-closed。 */
export const MANUAL_COMPACTION_INSTRUCTIONS_MAX_CHARS = 4_000;

/** 手动压缩的显式结果；CLI 与桌面共用，不靠 snapshot 状态猜失败原因。 */
export interface ManualCompactionResult {
  status: "compacted" | "skipped" | "failed" | "aborted";
  /** 跳过原因；只有 status 为 skipped 时出现。 */
  reason?: "insufficient-messages" | "below-threshold" | "breaker-open" | "checkpoint-invalid";
  /** 成功压缩后重新计算的上下文占用。 */
  usage?: ContextUsage;
  /** 失败原因；status 为 failed 时出现。 */
  errorText?: string;
}

/** 已成功摘要的边界；可回放给 transcript 展示摘要正文。 */
export const contextCompactionBoundarySchema = z.strictObject({
  id: z.string(),
  /** 摘要覆盖的最后一条 transcript 消息；边界显示在它之后。 */
  throughMessageId: z.string(),
  createdAt: z.string().datetime(),
  /** synthetic user message 使用的摘要正文；随边界下发并只在展开时展示。 */
  summary: z.string(),
  /** 截至该边界的累计摘要消息数。 */
  summarizedMessages: z.number().int().nonnegative(),
  /** 本次手动压缩附带的一次性摘要指令；自动压缩不产生。 */
  instructions: z.string().optional(),
});
/** 最近一次模型 step 的 provider 输入用量与关键预算阈值；只用于 UI，不参与压缩决策。 */
export const contextUsageSchema = z.strictObject({
  contextWindow: z.number().int().positive(),
  usedTokens: z.number().int().nonnegative(),
  source: z.enum(["estimate", "compaction", "provider"]).optional(),
  inputLimit: z.number().int().positive(),
  compactAt: z.number().int().positive(),
  pruneAt: z.number().int().nonnegative(),
  pruneTarget: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
});
/** 最近一次实际应用的旧工具结果清理；跳过时不产生状态。 */
export const contextPruningSchema = z.strictObject({
  trigger: contextCompactionTriggerSchema,
  prunedCount: z.number().int().positive(),
  savedTokens: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
});
export const agentRunSnapshotSchema = z.strictObject({
  runId: z.string(),
  state: agentRunStateSchema,
  attempt: z.number().int().positive(),
  generation: z.number().int().nonnegative(),
  currentStepId: z.string().optional(),
  updatedAt: z.string().datetime(),
});
export type AgentRunState = z.infer<typeof agentRunStateSchema>;
export type RunOutcome = z.infer<typeof runOutcomeSchema>;
export type TurnStatus = z.infer<typeof turnStatusSchema>;
export type TurnOutcome = z.infer<typeof turnOutcomeSchema>;
export type StepOutcome = z.infer<typeof stepOutcomeSchema>;
export type TurnSource = z.infer<typeof turnSourceSchema>;
export type TurnFinishReason = z.infer<typeof turnFinishReasonSchema>;
export type CompactionReason = z.infer<typeof compactionReasonSchema>;
export type AgentRetry = z.infer<typeof agentRetrySchema>;
export type AgentToolCallState = z.infer<typeof agentToolCallStateSchema>;
export type AgentMessageState = z.infer<typeof agentMessageStateSchema>;
export type AgentPartState = z.infer<typeof agentPartStateSchema>;
export type AgentPartKind = z.infer<typeof agentPartKindSchema>;
export type AgentFinishReason = z.infer<typeof agentFinishReasonSchema>;
export type AgentUsage = z.infer<typeof agentUsageSchema>;
export type AgentRunSnapshot = z.infer<typeof agentRunSnapshotSchema>;
export type ContextCompactionState = z.infer<typeof contextCompactionStateSchema>;
export type ContextCompactionTrigger = z.infer<typeof contextCompactionTriggerSchema>;
export type ContextCompactionStatus = z.infer<typeof contextCompactionSchema>;
export type ContextCompactionBoundary = z.infer<typeof contextCompactionBoundarySchema>;
export type ContextUsage = z.infer<typeof contextUsageSchema>;
export type ContextPruningStatus = z.infer<typeof contextPruningSchema>;
