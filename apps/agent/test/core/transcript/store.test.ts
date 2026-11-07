import { describe, expect, it } from "vitest";
import { MemoryConversationStore } from "../../../src/core/transcript/memoryStore";

describe("memory conversation transcript store", () => {
  it("appends completed user messages without creating an Agent run", async () => {
    const store = new MemoryConversationStore();
    await store.create("interview");
    await store.appendUserMessage("interview", {
      id: "user-1",
      role: "user",
      text: "我正在测试麦克风输入",
      images: [],
      status: "complete",
    });

    const snapshot = await store.load("interview");
    expect(snapshot.messages.map((message) => message.text)).toEqual(["我正在测试麦克风输入"]);
    expect(snapshot.activeRunId).toBeUndefined();
  });

  it("claims a reply run for the last user message without duplicating it", async () => {
    const store = new MemoryConversationStore();
    await store.create("interview");
    await store.appendUserMessage("interview", {
      id: "user-1",
      role: "user",
      text: "请自我介绍",
      images: [],
      status: "complete",
    });

    const claimed = await store.beginReplyRun("interview", "run-1");
    const snapshot = await store.load("interview");
    expect(claimed).toMatchObject({ id: "user-1", role: "user" });
    expect(snapshot.messages.map((message) => [message.id, message.role, message.status])).toEqual([
      ["user-1", "user", "complete"],
      ["run-1", "assistant", "streaming"],
    ]);
    expect(snapshot.activeRunId).toBe("run-1");
  });

  it("rejects missing or active reply runs without changing the transcript", async () => {
    const store = new MemoryConversationStore();
    await store.create("interview");
    await expect(store.beginReplyRun("interview", "run-1")).rejects.toThrow("没有可回复的用户消息");
    await store.beginRun("interview", "run-1", {
      id: "user-1",
      role: "user",
      text: "first",
      images: [],
      status: "complete",
    });
    await expect(store.beginReplyRun("interview", "run-2")).rejects.toThrow("当前回复尚未完成");
    expect((await store.load("interview")).messages.map((message) => message.id)).toEqual([
      "user-1",
      "run-1",
    ]);
  });

  it("appends stream text and settles the assistant transcript message", async () => {
    const store = new MemoryConversationStore();
    await store.create("session-a");
    await store.beginRun("session-a", "run-1", {
      id: "user-1",
      role: "user",
      text: "question",
      images: [],
      status: "complete",
    });
    await store.applyStreamEvent("session-a", "run-1", {
      type: "text-delta",
      partId: "text-1",
      delta: "answer",
    });
    await store.finishRun("session-a", "run-1", "completed");

    const snapshot = await store.load("session-a");
    expect(snapshot.messages.map((message) => message.id)).toEqual(["user-1", "run-1"]);
    expect(snapshot.messages[1]).toMatchObject({ text: "answer", status: "complete" });
    expect(snapshot.activeRunId).toBeUndefined();
    expect(snapshot.eventRevision).toBe(0);
  });

  it("claims ephemeral runs atomically and replaces the previous round", async () => {
    const store = new MemoryConversationStore();
    await store.create("session-e");
    await store.beginRun("session-e", "run-1", {
      id: "user-1",
      role: "user",
      text: "第一题",
      images: [],
      status: "complete",
    });
    await store.applyStreamEvent("session-e", "run-1", {
      type: "text-delta",
      partId: "text-1",
      delta: "答案：A",
    });
    await store.finishRun("session-e", "run-1", "completed");
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
    expect(snapshot.eventRevision).toBe(before.eventRevision);
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
    expect((await store.load("session-f")).activeRunId).toBe("run-1");
  });

  it("clears only when no run is active", async () => {
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
    expect((await store.load("session-g")).activeRunId).toBe("run-1");
    await store.finishRun("session-g", "run-1", "completed");
    await store.clear("session-g");
    expect((await store.load("session-g")).messages).toEqual([]);
  });
});
