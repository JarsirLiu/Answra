import { describe, expect, it } from "vitest";
import {
  applyAgentEvent,
  applyConversationSnapshot,
  EMPTY_CONVERSATION_VIEW,
} from "../src/app/conversationView";

describe("AgentEventEnvelope UI projection", () => {
  it("keeps reasoning and retry as separate event-driven states", () => {
    const view = applyConversationSnapshot(EMPTY_CONVERSATION_VIEW, {
      conversationId: "conversation",
      eventRevision: 0,
      messages: [{ id: "run-1", role: "assistant", text: "", images: [], status: "streaming" }],
      activeRunId: "run-1",
    });
    const retry = applyAgentEvent(view, {
      schemaVersion: 1,
      eventId: "e1",
      conversationId: "conversation",
      runId: "run-1",
      attemptId: "a1",
      sequence: 1,
      aggregateRevision: 2,
      producerId: "test",
      occurredAt: "2026-11-07T00:00:00.000Z",
      event: {
        type: "run-state-changed",
        state: "retry-wait",
        attempt: 1,
        retry: {
          kind: "rate-limit",
          attempt: 1,
          maxRetries: 5,
          delayMs: 100,
          scheduledAt: "2026-11-07T00:00:00.000Z",
        },
      },
    });
    expect(retry.retry?.maxRetries).toBe(5);
    expect(retry.messages[0]?.thinking).toBeUndefined();
  });
});
