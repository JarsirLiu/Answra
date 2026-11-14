import { z } from "zod";

/** Runtime status vocabulary used by the canonical Agent event flow and transcript. */
export const agentRetrySchema = z.strictObject({
  kind: z.enum(["rate-limit", "server-error", "network-error"]),
  attempt: z.number().int().positive(),
  maxRetries: z.number().int().positive(),
  delayMs: z.number().int().nonnegative(),
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
export const contextCompactionStateSchema = z.enum(["idle", "started", "failed", "succeeded"]);
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
/** 已成功摘要的边界；只暴露边界位置，不向 UI 暴露摘要正文。 */
export const contextCompactionBoundarySchema = z.strictObject({
  id: z.string(),
  /** 摘要覆盖的最后一条 transcript 消息；边界显示在它之后。 */
  throughMessageId: z.string(),
  createdAt: z.string().datetime(),
});
/** 当前模型请求的估算占用和关键预算阈值；只用于 UI 解释，不参与压缩决策。 */
export const contextUsageSchema = z.strictObject({
  contextWindow: z.number().int().positive(),
  usedTokens: z.number().int().nonnegative(),
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
