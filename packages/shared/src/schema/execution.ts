import { z } from "zod";

/**
 * Provider-neutral run and step facts for future hosted adapters. This vocabulary
 * stays independent of AI SDK and transport adapters.
 */
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

/** Terminal outcome of one model execution. */
export const runOutcomeSchema = z.enum(["completed", "failed", "aborted", "superseded"]);

export type RunOutcome = z.infer<typeof runOutcomeSchema>;

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

/** Provider-neutral retry fact shared by model stream and execution lifecycle. */
export const agentRetrySchema = z.strictObject({
  kind: z.enum(["rate-limit", "server-error", "network-error"]),
  attempt: z.number().int().positive(),
  maxRetries: z.number().int().positive(),
  delayMs: z.number().int().nonnegative(),
});

export const agentRetryWaitSchema = agentRetrySchema.extend({
  scheduledAt: z.string().datetime(),
});

/** AI SDK finish reasons, kept as product-owned values at the boundary. */
export const agentFinishReasonSchema = z.enum([
  "stop",
  "length",
  "content-filter",
  "tool-calls",
  "error",
  "other",
]);

/** Stable subset of AI SDK usage facts; provider-specific fields stay out. */
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

export const agentExecutionEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("run-state-changed"),
    state: agentRunStateSchema,
    attempt: z.number().int().positive(),
    retry: agentRetryWaitSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("step-started"),
    stepId: z.string(),
    index: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal("step-finished"),
    stepId: z.string(),
    index: z.number().int().nonnegative(),
    state: z.enum(["completed", "failed", "aborted"]),
    finishReason: agentFinishReasonSchema.optional(),
    usage: agentUsageSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("part-state-changed"),
    partId: z.string(),
    kind: agentPartKindSchema,
    state: z.enum(["started", "streaming", "completed", "failed"]),
  }),
]);

/**
 * Future event-store envelope. Current desktop sessions use ConversationEvent,
 * while hosted adapters can persist this envelope without changing payloads.
 */
export const agentEventEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  eventId: z.string(),
  tenantId: z.string().optional(),
  actorId: z.string().optional(),
  conversationId: z.string().optional(),
  runId: z.string(),
  attemptId: z.string(),
  stepId: z.string().optional(),
  sequence: z.number().int().positive(),
  aggregateRevision: z.number().int().nonnegative(),
  causationId: z.string().optional(),
  correlationId: z.string().optional(),
  producerId: z.string(),
  occurredAt: z.string().datetime(),
  event: agentExecutionEventSchema,
});

export type AgentRunState = z.infer<typeof agentRunStateSchema>;
export type AgentStepState = z.infer<typeof agentStepStateSchema>;
export type AgentPartKind = z.infer<typeof agentPartKindSchema>;
export type AgentRetry = z.infer<typeof agentRetrySchema>;
export type AgentFinishReason = z.infer<typeof agentFinishReasonSchema>;
export type AgentUsage = z.infer<typeof agentUsageSchema>;
export type AgentExecutionEvent = z.infer<typeof agentExecutionEventSchema>;
export type AgentRunSnapshot = z.infer<typeof agentRunSnapshotSchema>;
export type AgentStepSnapshot = z.infer<typeof agentStepSnapshotSchema>;
export type AgentEventEnvelope = z.infer<typeof agentEventEnvelopeSchema>;
