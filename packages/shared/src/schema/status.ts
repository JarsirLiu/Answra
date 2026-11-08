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
