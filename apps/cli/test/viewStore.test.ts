import type { ConversationSnapshot } from "@answra/shared";
import type { AgentEventEnvelope } from "@answra/shared/schema";
import { describe, expect, it, vi } from "vitest";
import { TuiViewStore } from "../src/tui/viewStore";

const snapshot: ConversationSnapshot = {
  conversationId: "conversation-1",
  eventRevision: 3,
  activeRunId: "run-1",
  messages: [
    {
      id: "run-1",
      role: "assistant",
      text: "",
      images: [],
      status: "streaming",
      parts: [{ id: "text-1", kind: "text", text: "", state: "started" }],
    },
  ],
};

function envelope(revision: number, event: AgentEventEnvelope["event"]): AgentEventEnvelope {
  return {
    schemaVersion: 1,
    eventId: `event-${revision}`,
    conversationId: "conversation-1",
    runId: "run-1",
    attemptId: "attempt-1",
    sequence: revision,
    aggregateRevision: revision,
    producerId: "test",
    occurredAt: new Date().toISOString(),
    event,
  };
}

describe("TuiViewStore", () => {
  it("initializes from a snapshot and applies batched text events", () => {
    const store = new TuiViewStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.initialize(snapshot);
    expect(store.getSnapshot().view.messages[0]?.parts).toEqual(snapshot.messages[0]?.parts);

    store.applyEvent(envelope(4, { type: "text-delta", partId: "text-1", delta: "hel" }));
    store.applyEvent(envelope(5, { type: "text-delta", partId: "text-1", delta: "lo" }));
    expect(store.getSnapshot().view.messages[0]?.text).toBe("");

    store.flush();
    expect(store.getSnapshot().view.messages[0]?.text).toBe("hello");
    expect(listener).toHaveBeenCalledTimes(2);
    store.dispose();
  });

  it("ignores stale snapshots and events", () => {
    const store = new TuiViewStore();
    store.initialize(snapshot);
    store.applyEvent(envelope(6, { type: "text-delta", partId: "text-1", delta: "new" }));
    store.flush();

    store.applySnapshot({ ...snapshot, eventRevision: 4 });
    store.applyEvent(envelope(5, { type: "text-delta", partId: "text-1", delta: "old" }));
    store.flush();

    expect(store.getSnapshot().view.eventRevision).toBe(6);
    expect(store.getSnapshot().view.messages[0]?.text).toBe("new");
    store.dispose();
  });

  it("flushes pending events before rejecting a stale snapshot", () => {
    const store = new TuiViewStore();
    store.initialize(snapshot);
    store.applyEvent(envelope(6, { type: "text-delta", partId: "text-1", delta: "new" }));

    store.applySnapshot({ ...snapshot, eventRevision: 5 });

    expect(store.getSnapshot().view.eventRevision).toBe(6);
    expect(store.getSnapshot().view.messages[0]?.text).toBe("new");
    store.dispose();
  });

  it("tracks phase and local errors separately from transcript state", () => {
    const store = new TuiViewStore();

    store.beginRun();
    expect(store.getSnapshot()).toMatchObject({ phase: "running", localError: undefined });
    store.markCancelling();
    expect(store.getSnapshot().phase).toBe("cancelling");
    store.fail("send failed");
    store.finishRun();
    expect(store.getSnapshot()).toMatchObject({ phase: "idle", localError: "send failed" });
    store.dispose();
  });

  it("tracks queued prompts, notices, and reset views", () => {
    const store = new TuiViewStore();
    store.initialize(snapshot);

    store.setQueued(2);
    store.setNotice(["会话已清除。"]);
    expect(store.getSnapshot()).toMatchObject({
      queued: 2,
      notice: ["会话已清除。"],
    });

    store.reset({ conversationId: "conversation-1", eventRevision: 9, messages: [] });
    expect(store.getSnapshot()).toMatchObject({
      queued: 0,
      notice: undefined,
      view: { eventRevision: 9, messages: [] },
      localError: undefined,
    });
    store.dispose();
  });

  it("stops notifying listeners after dispose", () => {
    const store = new TuiViewStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.dispose();

    store.applyEvent(envelope(4, { type: "text-delta", partId: "text-1", delta: "late" }));
    store.flush();

    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot().view.messages).toEqual([]);
  });
});
