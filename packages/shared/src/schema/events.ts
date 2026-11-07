import { z } from "zod";
import {
  agentFinishReasonSchema,
  agentPartKindSchema,
  agentRetryWaitSchema,
  agentRunStateSchema,
  agentUsageSchema,
} from "./status";
import type { AgentStreamEvent } from "./stream";
import { agentStreamEventSchema } from "./stream";

/** Existing run lifecycle payloads and model stream payloads share this envelope. */
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
export const agentEventSchema = z.union([agentExecutionEventSchema, agentStreamEventSchema]);
/** The one persisted and transported envelope for existing Agent event payloads. */
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
export type AgentEvent = AgentExecutionEvent | AgentStreamEvent;
export type AgentEventEnvelope = z.infer<typeof agentEventEnvelopeSchema>;
