import type { ConversationSnapshot } from "@answra/shared";
import type { AgentEventEnvelope } from "@answra/shared/schema";
import { describe, expect, it, vi } from "vitest";
import { TuiViewStore } from "../../../src/tui/app/viewStore";
import { DEFAULT_NOTIFICATION_TIMEOUT_MS } from "../../../src/tui/notices/notification";

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

function envelope(
  revision: number,
  event: AgentEventEnvelope["event"],
  conversationId = "conversation-1",
): AgentEventEnvelope {
  return {
    schemaVersion: 1,
    eventId: `event-${revision}`,
    conversationId,
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

  it("filters background conversation updates and resets the revision on switch", () => {
    const store = new TuiViewStore();
    store.initialize(snapshot);
    store.applyEvent(envelope(4, { type: "text-delta", partId: "text-1", delta: "one" }));
    store.flush();

    const target: ConversationSnapshot = {
      conversationId: "conversation-2",
      eventRevision: 2,
      messages: [{ id: "run-2", role: "assistant", text: "two", images: [], status: "complete" }],
    };
    store.switchConversation(target);
    expect(store.getSnapshot().view).toMatchObject({ eventRevision: 2 });

    store.applySnapshot({ ...snapshot, eventRevision: 99 });
    store.applyEvent(envelope(5, { type: "text-delta", partId: "text-1", delta: "hidden" }));
    store.flush();
    expect(store.getSnapshot().view).toMatchObject({
      eventRevision: 2,
      messages: [expect.objectContaining({ id: "run-2" })],
    });

    store.switchConversation(snapshot);
    expect(store.getSnapshot().view).toMatchObject({
      eventRevision: 3,
      messages: [expect.objectContaining({ id: "run-1" })],
    });
    store.dispose();
  });

  it("adds one CLI compaction boundary when a snapshot reports success", () => {
    const store = new TuiViewStore();
    const message = {
      id: "message-1",
      role: "user" as const,
      text: "question",
      images: [],
      status: "complete" as const,
    };
    const base: ConversationSnapshot = {
      conversationId: "conversation-1",
      eventRevision: 3,
      messages: [message],
      contextCompaction: {
        state: "started",
        trigger: "auto",
        startedAt: "2026-11-14T10:00:00.000Z",
        updatedAt: "2026-11-14T10:00:00.000Z",
      },
    };
    store.initialize(base);

    store.applySnapshot({
      ...base,
      eventRevision: 4,
      contextCompaction: {
        state: "succeeded",
        trigger: "auto",
        startedAt: "2026-11-14T10:00:00.000Z",
        updatedAt: "2026-11-14T10:00:01.000Z",
        finishedAt: "2026-11-14T10:00:01.000Z",
      },
    });
    store.applySnapshot({
      ...base,
      eventRevision: 5,
      contextCompaction: {
        state: "succeeded",
        trigger: "auto",
        startedAt: "2026-11-14T10:00:00.000Z",
        updatedAt: "2026-11-14T10:00:01.000Z",
        finishedAt: "2026-11-14T10:00:01.000Z",
      },
    });

    expect(store.getSnapshot().compactionBoundaries).toEqual([
      {
        id: "compaction:2026-11-14T10:00:01.000Z",
        afterMessageId: "message-1",
      },
    ]);

    store.reset({ conversationId: "conversation-1", eventRevision: 6, messages: [] });
    expect(store.getSnapshot().compactionBoundaries).toEqual([]);
    store.dispose();
  });

  it("restores compact boundaries from a conversation snapshot", () => {
    const store = new TuiViewStore();
    store.initialize({
      conversationId: "conversation-1",
      eventRevision: 2,
      messages: [
        {
          id: "message-1",
          role: "user",
          text: "question",
          images: [],
          status: "complete",
        },
      ],
      contextCompactionBoundaries: [
        {
          id: "compaction:2026-11-14T10:00:01.000Z:message-1",
          throughMessageId: "message-1",
          createdAt: "2026-11-14T10:00:01.000Z",
          summary: "压缩后的摘要",
          summarizedMessages: 8,
          instructions: "保留迁移决定",
        },
      ],
    });

    expect(store.getSnapshot().compactionBoundaries).toEqual([
      {
        id: "compaction:2026-11-14T10:00:01.000Z:message-1",
        afterMessageId: "message-1",
        summary: "压缩后的摘要",
        summarizedMessages: 8,
        instructions: "保留迁移决定",
      },
    ]);
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

  it("tracks queued prompts, notifications, and reset views", () => {
    const store = new TuiViewStore();
    store.initialize(snapshot);

    store.setQueued(2);
    store.notify({ key: "session", text: "会话已清除。", tone: "success" });
    expect(store.getSnapshot()).toMatchObject({
      queued: 2,
      notifications: { current: { text: "会话已清除。" } },
    });

    store.reset({ conversationId: "conversation-1", eventRevision: 9, messages: [] });
    expect(store.getSnapshot()).toMatchObject({
      queued: 0,
      notifications: { current: null },
      view: { eventRevision: 9, messages: [] },
      localError: undefined,
    });
    store.dispose();
  });

  it("auto-dismisses the current notification and advances the queue", () => {
    vi.useFakeTimers();
    try {
      const store = new TuiViewStore();
      store.notify({ key: "first", text: "first" });
      store.notify({ key: "second", text: "second" });

      expect(store.getSnapshot().notifications.current?.text).toBe("first");
      vi.advanceTimersByTime(DEFAULT_NOTIFICATION_TIMEOUT_MS);
      expect(store.getSnapshot().notifications.current?.text).toBe("second");
      vi.advanceTimersByTime(DEFAULT_NOTIFICATION_TIMEOUT_MS);
      expect(store.getSnapshot().notifications.current).toBeNull();
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets immediate notifications preempt the current one", () => {
    const store = new TuiViewStore();
    store.notify({ key: "background", text: "background", timeoutMs: null });
    store.notify({ key: "urgent", text: "urgent", priority: "immediate" });

    expect(store.getSnapshot().notifications.current?.text).toBe("urgent");
    store.dismissNotification("urgent");
    expect(store.getSnapshot().notifications.current?.text).toBe("background");
    store.dispose();
  });

  it("keeps blocking notifications until they are dismissed", () => {
    vi.useFakeTimers();
    try {
      const store = new TuiViewStore();
      store.notify({ key: "login-code", text: "输入授权码", timeoutMs: null });

      vi.advanceTimersByTime(DEFAULT_NOTIFICATION_TIMEOUT_MS * 10);
      expect(store.getSnapshot().notifications.current?.text).toBe("输入授权码");

      store.dismissNotification("login-code");
      expect(store.getSnapshot().notifications.current).toBeNull();
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaces a notification with the same key instead of stacking it", () => {
    const store = new TuiViewStore();
    store.notify({ key: "model", text: "old" });
    store.notify({ key: "model", text: "new" });

    expect(store.getSnapshot().notifications).toMatchObject({
      current: { text: "new" },
      queue: [],
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
