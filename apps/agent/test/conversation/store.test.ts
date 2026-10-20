import { describe, expect, it } from "vitest";
import { MemoryConversationStore } from "../../src/conversation/store";

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

  it("claims an ephemeral run atomically after wiping the previous round's leftovers", async () => {
    const store = new MemoryConversationStore();
    await store.create("session-e");
    await store.beginRun("session-e", "run-1", {
      id: "user-1",
      role: "user",
      text: "第一题",
      images: [],
      status: "complete",
    });
    await store.appendEvent({
      conversationId: "session-e",
      runId: "run-1",
      chunk: { type: "text-delta", id: "text-1", delta: "答案：A" },
    });
    await store.finishRun("session-e", "run-1", "complete");
    const before = await store.load("session-e");

    await store.beginEphemeralRun("session-e", "run-2", {
      id: "user-2",
      role: "user",
      text: "第二题",
      images: [],
      status: "complete",
    });

    const snapshot = await store.load("session-e");
    expect(snapshot.messages.map((message) => [message.id, message.text])).toEqual([
      ["user-2", "第二题"],
      ["run-2", ""],
    ]);
    expect(snapshot.activeRunId).toBe("run-2");
    expect(snapshot.revision).toBe(before.revision + 1);
    // 残留 journal 被清空：旧游标按既有规则降级为全量 snapshot 读取。
    expect((await store.readAfter("session-e", 0)).map((change) => change.type)).toEqual([
      "snapshot",
    ]);
  });

  it("rejects a concurrent ephemeral claim without touching the active run", async () => {
    const store = new MemoryConversationStore();
    await store.create("session-f");
    await store.beginRun("session-f", "run-1", {
      id: "user-1",
      role: "user",
      text: "first",
      images: [],
      status: "complete",
    });

    await expect(
      store.beginEphemeralRun("session-f", "run-2", {
        id: "user-2",
        role: "user",
        text: "second",
        images: [],
        status: "complete",
      }),
    ).rejects.toThrow("当前回复尚未完成");

    const snapshot = await store.load("session-f");
    expect(snapshot.activeRunId).toBe("run-1");
    expect(snapshot.messages.map((message) => message.id)).toEqual(["user-1", "run-1"]);
  });

  it("clears only when the conversation has no active run", async () => {
    const store = new MemoryConversationStore();
    await store.create("session-g");
    await store.beginRun("session-g", "run-1", {
      id: "user-1",
      role: "user",
      text: "first",
      images: [],
      status: "complete",
    });

    await store.clear("session-g");
    let snapshot = await store.load("session-g");
    expect(snapshot.activeRunId).toBe("run-1");
    expect(snapshot.messages.map((message) => message.id)).toEqual(["user-1", "run-1"]);

    await store.finishRun("session-g", "run-1", "complete");
    await store.clear("session-g");
    snapshot = await store.load("session-g");
    expect(snapshot.activeRunId).toBeUndefined();
    expect(snapshot.messages).toEqual([]);
  });
});
