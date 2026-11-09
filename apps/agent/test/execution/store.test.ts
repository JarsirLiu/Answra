import { describe, expect, it } from "vitest";
import { MemoryExecutionStore } from "../../src/execution/memoryStore";

describe("MemoryExecutionStore", () => {
  it("records one explicit lifecycle event for every run status transition", async () => {
    const store = new MemoryExecutionStore();
    await store.startRun({
      runId: "run-1",
      conversationId: "conversation-1",
      producerId: "test",
    });
    await store.transition("run-1", "running");
    await store.scheduleRetry("run-1", {
      kind: "rate-limit",
      attempt: 1,
      maxRetries: 5,
      delayMs: 50,
    });
    await store.resumeRetry("run-1");
    await store.finishRun("run-1", "completed");

    await expect(store.getRun("run-1")).resolves.toMatchObject({
      state: "completed",
      attempt: 2,
    });
    await expect(store.readEventsForRun("run-1")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: expect.objectContaining({ state: "claimed" }) }),
        expect.objectContaining({ event: expect.objectContaining({ state: "running" }) }),
        expect.objectContaining({ event: expect.objectContaining({ state: "retry-wait" }) }),
        expect.objectContaining({ event: expect.objectContaining({ state: "completed" }) }),
      ]),
    );
  });

  it("rejects a transition after the terminal state", async () => {
    const store = new MemoryExecutionStore();
    await store.startRun({ runId: "run-1", conversationId: "conversation-1", producerId: "test" });
    await store.transition("run-1", "running");
    await store.finishRun("run-1", "failed");

    await expect(store.transition("run-1", "running")).rejects.toThrow(
      "Invalid execution transition",
    );
  });

  it("publishes the same shared envelope that can be read back", async () => {
    const store = new MemoryExecutionStore();
    const published: string[] = [];
    store.subscribe((event) => published.push(event.event.type));

    await store.startRun({ runId: "run-1", conversationId: "conversation-1", producerId: "test" });

    expect(published).toEqual(["run-state-changed", "run-state-changed"]);
    await expect(store.readEvents("conversation-1", 0)).resolves.toHaveLength(2);
  });

  it("keeps conversation revisions ordered and applies the afterRevision boundary", async () => {
    const store = new MemoryExecutionStore();
    await store.startRun({ runId: "run-a", conversationId: "conversation-a", producerId: "test" });
    await store.transition("run-a", "running");
    await store.startRun({ runId: "run-b", conversationId: "conversation-b", producerId: "test" });

    await expect(store.getConversationRevision("conversation-a")).resolves.toBe(3);
    await expect(store.readEvents("conversation-a", 1)).resolves.toEqual([
      expect.objectContaining({ aggregateRevision: 2 }),
      expect.objectContaining({ aggregateRevision: 3 }),
    ]);
    await expect(store.readEvents("conversation-a", 3)).resolves.toEqual([]);
    await expect(store.readEvents("conversation-b", 0)).resolves.toHaveLength(2);
  });

  it("does not append or publish an illegal transition", async () => {
    const store = new MemoryExecutionStore();
    const published: string[] = [];
    store.subscribe((event) => published.push(event.event.type));
    await store.startRun({ runId: "run-1", conversationId: "conversation-1", producerId: "test" });
    await expect(store.transition("run-1", "completed")).rejects.toThrow(
      "Invalid execution transition",
    );

    await expect(store.getConversationRevision("conversation-1")).resolves.toBe(2);
    expect(published).toHaveLength(2);
  });

  it("makes terminal completion idempotent and does not publish a second terminal event", async () => {
    const store = new MemoryExecutionStore();
    const published: string[] = [];
    store.subscribe((event) => {
      if (event.event.type === "run-state-changed") published.push(event.event.state);
    });
    await store.startRun({ runId: "run-1", conversationId: "conversation-1", producerId: "test" });
    await store.transition("run-1", "running");
    await store.finishRun("run-1", "completed");
    await expect(store.finishRun("run-1", "completed")).resolves.toBeUndefined();

    expect(published).toEqual(["queued", "claimed", "running", "completed"]);
    await expect(store.readEventsForRun("run-1")).resolves.toHaveLength(4);
  });
});
