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
    await expect(store.readEvents("run-1")).resolves.toEqual(
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
    await expect(store.readEvents("run-1")).resolves.toHaveLength(2);
  });
});
