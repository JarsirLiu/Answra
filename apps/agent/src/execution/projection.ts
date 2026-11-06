/** Execution read projection reducer; each snapshot field is written by an event. */
import type { AgentEventEnvelope, AgentRunSnapshot } from "@answra/shared/schema";

export function applyExecutionEvent(
  current: AgentRunSnapshot,
  envelope: AgentEventEnvelope,
): AgentRunSnapshot {
  const event = envelope.event;
  if (event.type !== "run-state-changed") return current;
  return {
    ...current,
    state: event.state,
    attempt: event.attempt,
    updatedAt: envelope.occurredAt,
  };
}
