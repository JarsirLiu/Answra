import { z } from "zod";
import {
  agentFinishReasonSchema,
  agentPartKindSchema,
  agentPartStateSchema,
  agentRetrySchema,
  agentRetryWaitSchema,
  agentRunStateSchema,
  agentUsageSchema,
} from "./status";

/** Complete shared catalog of Agent event payloads and their single envelope. */
const executionEventOptions = [
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
    state: agentPartStateSchema,
  }),
] as const;

/** Model events eligible for durable storage, excluding high-frequency deltas. */
const durableCandidateStreamEventOptions = [
  // Generation lifecycle.
  z.strictObject({ type: z.literal("start") }),
  z.strictObject({
    type: z.literal("finish"),
    finishReason: agentFinishReasonSchema,
    usage: agentUsageSchema.optional(),
  }),
  z.strictObject({ type: z.literal("abort"), reason: z.string().optional() }),
  // Text and reasoning part boundaries.
  z.strictObject({ type: z.literal("text-start"), partId: z.string() }),
  z.strictObject({ type: z.literal("text-end"), partId: z.string() }),
  z.strictObject({ type: z.literal("reasoning-start"), partId: z.string() }),
  z.strictObject({ type: z.literal("reasoning-end"), partId: z.string() }),
  // Tool input, model requests, executor lifecycle, and results.
  z.strictObject({
    type: z.literal("tool-input-start"),
    toolCallId: z.string(),
    toolName: z.string(),
    title: z.string().optional(),
  }),
  z.strictObject({ type: z.literal("tool-input-end"), toolCallId: z.string() }),
  z.strictObject({
    type: z.literal("tool-call"),
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
  }),
  z.strictObject({
    type: z.literal("tool-result"),
    toolCallId: z.string(),
    output: z.unknown(),
  }),
  z.strictObject({
    type: z.literal("tool-error"),
    toolCallId: z.string(),
    errorText: z.string(),
  }),
  z.strictObject({
    type: z.literal("tool-output-denied"),
    toolCallId: z.string(),
    toolName: z.string(),
  }),
  z.strictObject({
    type: z.literal("tool-approval-request"),
    approvalId: z.string(),
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
    signature: z.string().optional(),
  }),
  /** AI SDK tool executor began running a model-requested tool. */
  z.strictObject({
    type: z.literal("tool-execution-started"),
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
    stepNumber: z.number().int().nonnegative().optional(),
  }),
  /** AI SDK tool executor completed, with its output or execution error. */
  z.strictObject({
    type: z.literal("tool-execution-finished"),
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
    result: z.discriminatedUnion("success", [
      z.strictObject({ success: z.literal(true), output: z.unknown() }),
      z.strictObject({ success: z.literal(false), errorText: z.string() }),
    ]),
    durationMs: z.number().nonnegative(),
    stepNumber: z.number().int().nonnegative().optional(),
  }),
  /** Model provider reported a requested feature that it cannot support. */
  z.strictObject({
    type: z.literal("model-warning-unsupported"),
    feature: z.string(),
    details: z.string().optional(),
  }),
  /** Model provider used a compatibility behavior that may affect output quality. */
  z.strictObject({
    type: z.literal("model-warning-compatibility"),
    feature: z.string(),
    details: z.string().optional(),
  }),
  z.strictObject({ type: z.literal("model-warning-other"), message: z.string() }),
  // Sources and generated file content.
  z.strictObject({
    type: z.literal("source-url"),
    sourceId: z.string(),
    url: z.string(),
    title: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("source-document"),
    sourceId: z.string(),
    mediaType: z.string(),
    title: z.string(),
  }),
  z.strictObject({
    type: z.literal("file"),
    mediaType: z.string(),
    base64: z.string(),
  }),
  // Retry and terminal stream error.
  z.strictObject({ type: z.literal("retry"), ...agentRetrySchema.shape }),
  z.strictObject({ type: z.literal("error"), errorText: z.string() }),
] as const;

/** High-frequency deltas are live events only and are not durable candidates. */
const liveOnlyStreamEventOptions = [
  z.strictObject({
    type: z.literal("text-delta"),
    partId: z.string(),
    delta: z.string(),
  }),
  z.strictObject({
    type: z.literal("reasoning-delta"),
    partId: z.string(),
    delta: z.string(),
  }),
  z.strictObject({
    type: z.literal("tool-input-delta"),
    toolCallId: z.string(),
    delta: z.string(),
  }),
  z.strictObject({
    type: z.literal("tool-output-delta"),
    toolCallId: z.string(),
    delta: z.string(),
  }),
] as const;

const streamEventOptions = [
  ...durableCandidateStreamEventOptions,
  ...liveOnlyStreamEventOptions,
] as const;

/** Normalized model stream events, including high-frequency live deltas. */
export const agentStreamEventSchema = z.discriminatedUnion("type", streamEventOptions);
/** Execution lifecycle events share the same complete Agent event catalog. */
export const agentExecutionEventSchema = z.discriminatedUnion("type", executionEventOptions);
/** The one complete event payload union used by the envelope, store and consumers. */
export const agentEventSchema = z.discriminatedUnion("type", [
  ...executionEventOptions,
  ...streamEventOptions,
]);

/** Durable-eligible payload kinds; this does not imply an implemented durable store. */
export const agentDurableEventSchema = z.discriminatedUnion("type", [
  ...executionEventOptions,
  ...durableCandidateStreamEventOptions,
]);

/** The single transport envelope for every Agent event payload. */
export const agentEventEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  eventId: z.string(),
  tenantId: z.string().optional(),
  actorId: z.string().optional(),
  conversationId: z.string(),
  runId: z.string(),
  attemptId: z.string(),
  stepId: z.string().optional(),
  sequence: z.number().int().positive(),
  aggregateRevision: z.number().int().nonnegative(),
  causationId: z.string().optional(),
  correlationId: z.string().optional(),
  producerId: z.string(),
  occurredAt: z.string().datetime(),
  event: agentEventSchema,
});

export type AgentExecutionEvent = z.infer<typeof agentExecutionEventSchema>;
export type AgentStreamEvent = z.infer<typeof agentStreamEventSchema>;
export type AgentEvent = z.infer<typeof agentEventSchema>;
export type AgentDurableEvent = z.infer<typeof agentDurableEventSchema>;
export type AgentEventEnvelope = z.infer<typeof agentEventEnvelopeSchema>;
