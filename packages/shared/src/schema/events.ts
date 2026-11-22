import { z } from "zod";
import { conversationMessageSchema } from "./conversation";
import {
  agentFinishReasonSchema,
  agentPartKindSchema,
  agentPartStateSchema,
  agentRetrySchema,
  agentRetryWaitSchema,
  agentRunStateSchema,
  agentUsageSchema,
  compactionReasonSchema,
  contextCompactionTriggerSchema,
  stepOutcomeSchema,
  turnFinishReasonSchema,
  turnOutcomeSchema,
  turnSourceSchema,
} from "./status";

/** 派生 UI 生命周期（旧 run 词汇），不是可落盘事实；迁移期只由旧 wire envelope 承载。 */
const derivedLifecycleEventOptions = [
  z.strictObject({
    type: z.literal("run-state-changed"),
    state: agentRunStateSchema,
    attempt: z.number().int().positive(),
    retry: agentRetryWaitSchema.optional(),
  }),
] as const;

/** durable 事实：用户可见的 Turn/Step/压缩生命周期与上下文用量。 */
const durableFactEventOptions = [
  /** 用户输入被接纳；turnId 在 envelope，payload 保留可重放的消息内容。 */
  z.strictObject({
    type: z.literal("turn-queued"),
    source: turnSourceSchema,
    input: conversationMessageSchema.optional(),
    agentId: z.string(),
  }),
  z.strictObject({
    type: z.literal("turn-started"),
    agentId: z.string(),
  }),
  z.strictObject({
    type: z.literal("turn-finished"),
    status: turnOutcomeSchema,
    reason: turnFinishReasonSchema.optional(),
    errorText: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("turn-handoff"),
    fromAgentId: z.string(),
    toAgentId: z.string(),
    task: z.string(),
  }),
  z.strictObject({
    type: z.literal("compaction-started"),
    trigger: contextCompactionTriggerSchema,
    reason: compactionReasonSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("compaction-finished"),
    summarizedMessages: z.number().int().nonnegative(),
    summary: z.string(),
    usage: agentUsageSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("compaction-failed"),
    errorText: z.string(),
  }),
  /** 宿主取消压缩；与 failed 分开，避免恢复后把用户主动取消误报成失败。 */
  z.strictObject({
    type: z.literal("compaction-aborted"),
  }),
  z.strictObject({
    type: z.literal("step-started"),
    stepId: z.string(),
    index: z.number().int().nonnegative(),
    agentId: z.string().optional(),
    modelId: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("step-finished"),
    stepId: z.string(),
    index: z.number().int().nonnegative(),
    state: stepOutcomeSchema,
    finishReason: agentFinishReasonSchema.optional(),
    usage: agentUsageSchema.optional(),
    errorText: z.string().optional(),
  }),
  /** Provider-reported input token count after a model step; drives live usage UI and recovery state. */
  z.strictObject({
    type: z.literal("context-usage-changed"),
    usedTokens: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal("part-state-changed"),
    partId: z.string(),
    kind: agentPartKindSchema,
    state: agentPartStateSchema,
  }),
] as const;

/** 旧 wire 的完整执行事件联合；`run-state-changed` 只存在于这里，不进 journal 或 frame。 */
const executionEventOptions = [
  ...derivedLifecycleEventOptions,
  ...durableFactEventOptions,
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
/** 旧 wire 的执行事件联合；包含派生的 `run-state-changed`，不是事实目录。 */
export const agentExecutionEventSchema = z.discriminatedUnion("type", executionEventOptions);
/** The one complete event payload union used by the legacy wire envelope. */
export const agentEventSchema = z.discriminatedUnion("type", [
  ...executionEventOptions,
  ...streamEventOptions,
]);

/** Durable event payloads: facts only. Derived lifecycle never enters a journal or a frame. */
export const agentDurableEventSchema = z.discriminatedUnion("type", [
  ...durableFactEventOptions,
  ...durableCandidateStreamEventOptions,
]);

/** High-frequency deltas: live-only, never persisted, never part of a SessionFrame. */
export const agentLiveOnlyEventSchema = z.discriminatedUnion("type", liveOnlyStreamEventOptions);

/** The legacy transport envelope for every Agent event payload. */
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

/** Session journal 的目标 envelope；迁移期与旧 run envelope 并存，稳定后删旧字段。 */
export const sessionEventEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  eventId: z.string(),
  sessionId: z.string(),
  turnId: z.string().optional(),
  messageId: z.string().optional(),
  stepId: z.string().optional(),
  operationId: z.string().optional(),
  sequence: z.number().int().positive(),
  producerId: z.string(),
  occurredAt: z.string().datetime(),
  event: agentDurableEventSchema,
});

export type AgentExecutionEvent = z.infer<typeof agentExecutionEventSchema>;
export type AgentStreamEvent = z.infer<typeof agentStreamEventSchema>;
export type AgentEvent = z.infer<typeof agentEventSchema>;
export type AgentDurableEvent = z.infer<typeof agentDurableEventSchema>;
export type AgentLiveOnlyEvent = z.infer<typeof agentLiveOnlyEventSchema>;
export type AgentEventEnvelope = z.infer<typeof agentEventEnvelopeSchema>;
export type SessionEventEnvelope = z.infer<typeof sessionEventEnvelopeSchema>;
