import type { AgentEventEnvelope } from "@answra/shared/schema";
import { describe, expect, it } from "vitest";
import {
  applyAgentEvent,
  applyConversationSnapshot,
  type ConversationView,
  EMPTY_CONVERSATION_VIEW,
} from "../src/app/conversationView";

const CONVERSATION = "active-interview-conversation";

function envelope(
  aggregateRevision: number,
  event: AgentEventEnvelope["event"],
  runId = "run-1",
): AgentEventEnvelope {
  return {
    schemaVersion: 1,
    eventId: `event-${aggregateRevision}`,
    conversationId: CONVERSATION,
    runId,
    attemptId: `${runId}:attempt:1`,
    sequence: aggregateRevision,
    aggregateRevision,
    producerId: "test",
    occurredAt: "2026-11-07T00:00:00.000Z",
    event,
  };
}

describe("conversation projection", () => {
  it("keeps snapshot messages and appends streamed text to the active assistant", () => {
    const view = applyConversationSnapshot(EMPTY_CONVERSATION_VIEW, {
      conversationId: CONVERSATION,
      revision: 1,
      activeRunId: "run-1",
      messages: [
        { id: "user-1", role: "user", text: "请自我介绍", images: [], status: "complete" },
        { id: "run-1", role: "assistant", text: "", images: [], status: "streaming" },
      ],
    });
    const next = applyAgentEvent(
      view,
      envelope(2, { type: "text-delta", partId: "text-1", delta: "先说经历" }),
    );
    expect(next.messages[1]).toMatchObject({ text: "先说经历", status: "streaming" });
  });

  it("keeps reasoning and rate-limit retry as separate explicit states", () => {
    const base: ConversationView = {
      revision: 1,
      activeRunId: "run-1",
      messages: [{ id: "run-1", role: "assistant", text: "", status: "streaming" }],
    };
    const thinking = applyAgentEvent(
      base,
      envelope(2, { type: "reasoning-start", partId: "reasoning-1" }),
    );
    expect(thinking.messages[0]?.thinking).toBe(true);
    const retrying = applyAgentEvent(
      thinking,
      envelope(3, {
        type: "run-state-changed",
        state: "retry-wait",
        attempt: 1,
        retry: {
          kind: "rate-limit",
          attempt: 1,
          maxRetries: 5,
          delayMs: 5_000,
          scheduledAt: "2026-11-07T00:00:00.000Z",
        },
      }),
    );
    expect(retrying.messages[0]?.thinking).toBe(true);
    expect(retrying.retry).toMatchObject({ kind: "rate-limit", attempt: 1, maxRetries: 5 });
    expect(retrying.retryRunId).toBe("run-1");
  });

  it("uses terminal run state to end the assistant message", () => {
    const view: ConversationView = {
      revision: 1,
      activeRunId: "run-1",
      messages: [{ id: "run-1", role: "assistant", text: "说到一半", status: "streaming" }],
    };
    const finished = applyAgentEvent(
      view,
      envelope(2, { type: "run-state-changed", state: "failed", attempt: 1 }),
    );
    expect(finished.activeRunId).toBeUndefined();
    expect(finished.messages[0]).toMatchObject({ status: "failed", thinking: false });
  });

  it("ignores old revisions and other conversations", () => {
    const view: ConversationView = { revision: 5, messages: [] };
    expect(applyAgentEvent(view, envelope(5, { type: "start" }))).toBe(view);
  });
});
