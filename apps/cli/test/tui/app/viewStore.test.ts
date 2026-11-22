import type { ConversationSnapshot, SessionFrame } from "@answra/shared";
import { describe, expect, it, vi } from "vitest";
import { TuiViewStore } from "../../../src/tui/app/viewStore";
import { DEFAULT_NOTIFICATION_TIMEOUT_MS } from "../../../src/tui/notices/notification";
import { liveFrame, sessionFrame } from "../../frameFixtures";

const snapshot: ConversationSnapshot = {
  conversationId: "conversation-1",
  eventRevision: 3,
  lastSeq: 0,
  messages: [
    {
      id: "message-1",
      role: "assistant",
      text: "",
      images: [],
      status: "streaming",
      parts: [{ id: "text-1", kind: "text", text: "", state: "started" }],
    },
  ],
};

describe("TuiViewStore", () => {
  it("initializes from a snapshot and applies batched live text increments", () => {
    const store = new TuiViewStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.initialize(snapshot);
    expect(store.getSnapshot().view.messages[0]?.parts).toEqual(snapshot.messages[0]?.parts);

    store.applyLiveFrame(
      liveFrame({ type: "text-delta", partId: "text-1", delta: "hel" }, { messageId: "message-1" }),
    );
    store.applyLiveFrame(
      liveFrame({ type: "text-delta", partId: "text-1", delta: "lo" }, { messageId: "message-1" }),
    );
    expect(store.getSnapshot().view.messages[0]?.text).toBe("");

    store.flushLive();
    expect(store.getSnapshot().view.messages[0]?.text).toBe("hello");
    expect(listener).toHaveBeenCalledTimes(2);
    store.dispose();
  });

  it("ignores a stale snapshot and a replayed durable frame", () => {
    const store = new TuiViewStore();
    store.initialize(snapshot);
    store.applyFrame(
      sessionFrame(
        1,
        { type: "turn-started", agentId: "coding.engineer" },
        { turnId: "turn-1", messageId: "message-1" },
      ),
    );

    const [firstMessage] = snapshot.messages;
    if (firstMessage === undefined) throw new Error("fixture must contain one message");
    store.applySnapshot({
      ...snapshot,
      lastSeq: 0,
      messages: [{ ...firstMessage, text: "stale" }],
    });
    store.applyFrame(sessionFrame(1, { type: "context-usage-changed", usedTokens: 1 }));

    expect(store.getSnapshot().view.lastSeq).toBe(1);
    expect(store.getSnapshot().view.messages[0]?.text).toBe("");
    store.dispose();
  });

  it("flushes pending live increments before rejecting a stale snapshot", () => {
    const store = new TuiViewStore();
    store.initialize(snapshot);
    store.applyFrame(
      sessionFrame(
        1,
        { type: "turn-started", agentId: "coding.engineer" },
        { turnId: "turn-1", messageId: "message-1" },
      ),
    );
    store.applyLiveFrame(
      liveFrame({ type: "text-delta", partId: "text-1", delta: "new" }, { messageId: "message-1" }),
    );

    store.applySnapshot({ ...snapshot, lastSeq: 0 });

    expect(store.getSnapshot().view.lastSeq).toBe(1);
    expect(store.getSnapshot().view.messages[0]?.text).toBe("new");
    store.dispose();
  });

  it("updates context usage from a durable frame before the turn finishes", () => {
    const store = new TuiViewStore();
    store.initialize({
      ...snapshot,
      contextUsage: {
        contextWindow: 256_000,
        usedTokens: 2_400,
        source: "estimate",
        inputLimit: 216_000,
        compactAt: 216_000,
        pruneAt: 172_000,
        pruneTarget: 40_000,
        updatedAt: "2026-11-14T10:00:00.000Z",
      },
    });

    store.applyFrame(sessionFrame(1, { type: "context-usage-changed", usedTokens: 2_700 }));

    expect(store.getSnapshot().view.contextUsage).toMatchObject({
      usedTokens: 2_700,
      source: "provider",
      inputLimit: 216_000,
    });
    expect(store.getSnapshot().view.lastSeq).toBe(1);
    store.dispose();
  });

  it("filters background conversation updates and resets the cursor on switch", () => {
    const store = new TuiViewStore();
    store.initialize(snapshot);
    store.applyLiveFrame(
      liveFrame({ type: "text-delta", partId: "text-1", delta: "one" }, { messageId: "message-1" }),
    );
    store.flushLive();

    const target: ConversationSnapshot = {
      conversationId: "conversation-2",
      eventRevision: 2,
      lastSeq: 0,
      messages: [
        { id: "message-2", role: "assistant", text: "two", images: [], status: "complete" },
      ],
    };
    store.switchConversation(target);
    expect(store.getSnapshot().view.messages).toMatchObject([{ id: "message-2" }]);

    store.applySnapshot({ ...snapshot, eventRevision: 99 });
    store.applyLiveFrame(
      liveFrame(
        { type: "text-delta", partId: "text-1", delta: "hidden" },
        { messageId: "message-1" },
      ),
    );
    store.flushLive();
    expect(store.getSnapshot().view.messages).toMatchObject([{ id: "message-2" }]);

    store.switchConversation(snapshot);
    expect(store.getSnapshot().view.messages).toMatchObject([{ id: "message-1" }]);
    store.dispose();
  });

  it("reloads the durable gap from the reader when a frame arrives out of order", async () => {
    const frames: SessionFrame[] = [];
    const readFrames = vi.fn(async (_conversationId: string, afterSeq: number) =>
      frames.filter((frame) => frame.seq > afterSeq),
    );
    const store = new TuiViewStore({ readFrames });
    store.initialize(snapshot);
    await vi.waitFor(() => expect(readFrames).toHaveBeenCalledWith("conversation-1", 0));

    const started = sessionFrame(
      1,
      { type: "turn-started", agentId: "coding.engineer" },
      { turnId: "turn-1", messageId: "message-1" },
    );
    const finished = sessionFrame(
      2,
      { type: "turn-finished", status: "completed" },
      { turnId: "turn-1", messageId: "message-1" },
    );
    frames.push(started, finished);
    store.applyFrame(finished);

    await vi.waitFor(() => expect(store.getSnapshot().view.lastSeq).toBe(2));
    expect(readFrames).toHaveBeenLastCalledWith("conversation-1", 0);
    expect(store.getSnapshot().view.messages[0]).toMatchObject({
      id: "message-1",
      status: "complete",
    });
    expect(store.getSnapshot().view.activeTurnId).toBeUndefined();
    expect(store.getSnapshot().view.activeMessageId).toBeUndefined();
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
      lastSeq: 0,
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

    store.reset({ conversationId: "conversation-1", eventRevision: 6, lastSeq: 0, messages: [] });
    expect(store.getSnapshot().compactionBoundaries).toEqual([]);
    store.dispose();
  });

  it("restores compact boundaries from a conversation snapshot", () => {
    const store = new TuiViewStore();
    store.initialize({
      conversationId: "conversation-1",
      eventRevision: 2,
      lastSeq: 0,
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

    store.setQueuedPrompts([
      { id: "queued-1", text: "sending", imageCount: 0, status: "sending" },
      { id: "queued-2", text: "waiting", imageCount: 1, status: "queued" },
    ]);
    store.notify({ key: "session", text: "会话已清除。", tone: "success" });
    expect(store.getSnapshot()).toMatchObject({
      queued: 1,
      queuedPrompts: [
        { id: "queued-1", text: "sending", status: "sending" },
        { id: "queued-2", text: "waiting", imageCount: 1, status: "queued" },
      ],
      notifications: { current: { text: "会话已清除。" } },
    });

    store.reset({ conversationId: "conversation-1", eventRevision: 9, lastSeq: 0, messages: [] });
    expect(store.getSnapshot()).toMatchObject({
      queued: 0,
      queuedPrompts: [],
      notifications: { current: null },
      view: { lastSeq: 0, messages: [] },
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

    store.applyLiveFrame(
      liveFrame(
        { type: "text-delta", partId: "text-1", delta: "late" },
        { messageId: "message-1" },
      ),
    );
    store.flushLive();

    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot().view.messages).toEqual([]);
  });
});
