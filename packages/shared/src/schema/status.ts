import { z } from "zod";

/** Retry metadata and run/step status vocabulary with rebuildable snapshots. */
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
export const agentStepStateSchema = z.enum([
  "started",
  "streaming",
  "tool-awaiting",
  "tool-running",
  "completed",
  "failed",
  "aborted",
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
export const agentStepSnapshotSchema = z.strictObject({
  stepId: z.string(),
  runId: z.string(),
  state: agentStepStateSchema,
  index: z.number().int().nonnegative(),
  finishReason: agentFinishReasonSchema.optional(),
  usage: agentUsageSchema.optional(),
  updatedAt: z.string().datetime(),
});
export type AgentRunState = z.infer<typeof agentRunStateSchema>;
export type RunOutcome = z.infer<typeof runOutcomeSchema>;
export type AgentRetry = z.infer<typeof agentRetrySchema>;
export type AgentStepState = z.infer<typeof agentStepStateSchema>;
export type AgentPartKind = z.infer<typeof agentPartKindSchema>;
export type AgentFinishReason = z.infer<typeof agentFinishReasonSchema>;
export type AgentUsage = z.infer<typeof agentUsageSchema>;
export type AgentRunSnapshot = z.infer<typeof agentRunSnapshotSchema>;
export type AgentStepSnapshot = z.infer<typeof agentStepSnapshotSchema>;
