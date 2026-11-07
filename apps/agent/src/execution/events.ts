/**
 * Creates the shared AgentEventEnvelope around an already-defined event payload.
 * Event variants live in @answra/shared/schema; this file is not their catalog.
 */
import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentEventEnvelope } from "@answra/shared/schema";

export interface ExecutionEventContext {
  runId: string;
  attemptId: string;
  conversationId: string;
  stepId?: string;
  producerId: string;
  sequence: number;
  aggregateRevision: number;
  occurredAt: string;
}

export function createExecutionEvent(
  context: ExecutionEventContext,
  event: AgentEvent,
): AgentEventEnvelope {
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    conversationId: context.conversationId,
    runId: context.runId,
    attemptId: context.attemptId,
    ...(context.stepId === undefined ? {} : { stepId: context.stepId }),
    sequence: context.sequence,
    aggregateRevision: context.aggregateRevision,
    producerId: context.producerId,
    occurredAt: context.occurredAt,
    event,
  };
}
