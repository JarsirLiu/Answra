import { describe, expect, it } from "vitest";
import { MemoryConversationStore } from "../src/conversationStore";

describe("memory conversation store", () => {
  it("assigns monotonic revisions and replays changes after a cursor", async () => {
    const store = new MemoryConversationStore();
    await store.create("session-a");
    await store.beginRun("session-a", "run-1", {
      id: "user-1",
      role: "user",
      text: "question",
      images: [],
      status: "complete",
    });
    const first = await store.appendEvent({
      conversationId: "session-a",
      runId: "run-1",
      chunk: { type: "text-delta", id: "text-1", delta: "answer" },
    });
    await store.finishRun("session-a", "run-1", "complete");

    const snapshot = await store.load("session-a");
    expect(snapshot.messages.map((message) => message.id)).toEqual(["user-1", "run-1"]);
    expect(snapshot.messages[1]).toMatchObject({ text: "answer", status: "complete" });
    expect(snapshot.activeRunId).toBeUndefined();
    expect(snapshot.revision).toBe(3);
    expect(
      (await store.readAfter("session-a", 2)).map((change) =>
        change.type === "event"
          ? change.event.revision
          : change.type === "snapshot"
            ? change.snapshot.revision
            : change.revision,
      ),
    ).toEqual([3]);
    expect(first.type).toBe("event");
  });

  it("falls back to the current snapshot when the requested cursor was evicted", async () => {
    const store = new MemoryConversationStore();
    await store.create("session-b");
    await store.beginRun("session-b", "run-1", {
      id: "user-1",
      role: "user",
      text: "question",
      images: [],
      status: "complete",
    });
    for (let index = 0; index < 2050; index += 1) {
      await store.appendEvent({
        conversationId: "session-b",
        runId: "run-1",
        chunk: { type: "text-delta", id: "text-1", delta: "x" },
      });
    }

    const recovered = await store.readAfter("session-b", 0);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ type: "snapshot", snapshot: { revision: 2051 } });
  });

  it("rejects a second run atomically without appending its user message", async () => {
    const store = new MemoryConversationStore();
    await store.create("session-c");
    await store.beginRun("session-c", "run-1", {
      id: "user-1",
      role: "user",
      text: "first",
      images: [],
      status: "complete",
    });

    await expect(
      store.beginRun("session-c", "run-2", {
        id: "user-2",
        role: "user",
        text: "second",
        images: [],
        status: "complete",
      }),
    ).rejects.toThrow("当前回复尚未完成");
    const snapshot = await store.load("session-c");
    expect(snapshot.messages.map((message) => message.id)).toEqual(["user-1", "run-1"]);
  });
});
