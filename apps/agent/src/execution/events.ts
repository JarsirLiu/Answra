/** Execution event writer; creates the shared, provider-neutral event envelope. */
import { randomUUID } from "node:crypto";
import type { AgentEventEnvelope, AgentExecutionEvent } from "@answra/shared/schema";

export interface ExecutionEventContext {
  runId: string;
  attemptId: string;
  conversationId: string;
  producerId: string;
  sequence: number;
  aggregateRevision: number;
  occurredAt: string;
}

export function createExecutionEvent(
  context: ExecutionEventContext,
  event: AgentExecutionEvent,
): AgentEventEnvelope {
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    conversationId: context.conversationId,
    runId: context.runId,
    attemptId: context.attemptId,
    sequence: context.sequence,
    aggregateRevision: context.aggregateRevision,
    producerId: context.producerId,
    occurredAt: context.occurredAt,
    event,
  };
}
