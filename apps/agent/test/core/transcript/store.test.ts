import type { AgentEvent, AgentEventEnvelope } from "@answra/shared/schema";
import { describe, expect, it } from "vitest";
import { MemoryConversationStore } from "../../../src/core/transcript/memoryStore";

function eventEnvelope(
  conversationId: string,
  runId: string,
  aggregateRevision: number,
  event: AgentEvent,
): AgentEventEnvelope {
  return {
    schemaVersion: 1,
    eventId: `event-${aggregateRevision}`,
    conversationId,
    runId,
    attemptId: `${runId}:attempt:1`,
    sequence: aggregateRevision,
    aggregateRevision,
    producerId: "test",
    occurredAt: "2026-11-08T00:00:00.000Z",
    event,
  };
}

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
    await store.applyAgentEvent(
      "session-a",
      eventEnvelope("session-a", "run-1", 1, {
        type: "text-delta",
        partId: "text-1",
        delta: "answer",
      }),
    );
    await store.applyAgentEvent(
      "session-a",
      eventEnvelope("session-a", "run-1", 2, {
        type: "run-state-changed",
        state: "completed",
        attempt: 1,
      }),
    );

    const snapshot = await store.load("session-a");
    expect(snapshot.messages.map((message) => message.id)).toEqual(["user-1", "run-1"]);
    expect(snapshot.messages[1]).toMatchObject({ text: "answer", status: "complete" });
    expect(snapshot.activeRunId).toBeUndefined();
    expect(snapshot.eventRevision).toBe(2);
  });

  it("stores reasoning and tool lifecycle as typed message parts", async () => {
    const store = new MemoryConversationStore();
    await store.create("session-parts");
    await store.beginRun("session-parts", "run-1", {
      id: "user-1",
      role: "user",
      text: "question",
      images: [],
      status: "complete",
    });
    await store.applyAgentEvent(
      "session-parts",
      eventEnvelope("session-parts", "run-1", 1, {
        type: "reasoning-start",
        partId: "reason-1",
      }),
    );
    await store.applyAgentEvent(
      "session-parts",
      eventEnvelope("session-parts", "run-1", 2, {
        type: "reasoning-delta",
        partId: "reason-1",
        delta: "think",
      }),
    );
    await store.applyAgentEvent(
      "session-parts",
      eventEnvelope("session-parts", "run-1", 3, {
        type: "tool-call",
        toolCallId: "tool-1",
        toolName: "Search",
        input: { query: "topic" },
      }),
    );
    await store.applyAgentEvent(
      "session-parts",
      eventEnvelope("session-parts", "run-1", 4, {
        type: "tool-execution-started",
        toolCallId: "tool-1",
        toolName: "Search",
        input: { query: "topic" },
      }),
    );
    await store.applyAgentEvent(
      "session-parts",
      eventEnvelope("session-parts", "run-1", 5, {
        type: "tool-result",
        toolCallId: "tool-1",
        output: "result",
      }),
    );

    const snapshot = await store.load("session-parts");
    expect(snapshot.messages[1]).toMatchObject({
      reasoning: "think",
      parts: [
        { id: "reason-1", kind: "reasoning", text: "think", state: "streaming" },
        {
          id: "tool-1",
          kind: "tool",
          toolName: "Search",
          state: "completed",
          input: { query: "topic" },
          output: "result",
        },
      ],
    });
  });

  it.each([
    ["failed", "failed"],
    ["aborted", "interrupted"],
  ] as const)("settles unfinished parts as %s when a run ends", async (runState, partState) => {
    const store = new MemoryConversationStore();
    await store.create("session-terminal-parts");
    await store.beginRun("session-terminal-parts", "run-1", {
      id: "user-1",
      role: "user",
      text: "question",
      images: [],
      status: "complete",
    });
    await store.applyAgentEvent(
      "session-terminal-parts",
      eventEnvelope("session-terminal-parts", "run-1", 1, {
        type: "text-start",
        partId: "text-1",
      }),
    );
    await store.applyAgentEvent(
      "session-terminal-parts",
      eventEnvelope("session-terminal-parts", "run-1", 2, {
        type: "tool-call",
        toolCallId: "tool-1",
        toolName: "Search",
        input: { query: "topic" },
      }),
    );
    await store.applyAgentEvent(
      "session-terminal-parts",
      eventEnvelope("session-terminal-parts", "run-1", 3, {
        type: "run-state-changed",
        state: runState,
        attempt: 1,
      }),
    );

    const snapshot = await store.load("session-terminal-parts");
    expect(snapshot.messages[1]).toMatchObject({
      status: runState === "failed" ? "failed" : "interrupted",
      parts: [
        { id: "text-1", kind: "text", state: partState },
        { id: "tool-1", kind: "tool", state: partState },
      ],
    });
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
    await store.applyAgentEvent(
      "session-e",
      eventEnvelope("session-e", "run-1", 1, {
        type: "text-delta",
        partId: "text-1",
        delta: "答案：A",
      }),
    );
    await store.applyAgentEvent(
      "session-e",
      eventEnvelope("session-e", "run-1", 2, {
        type: "run-state-changed",
        state: "completed",
        attempt: 1,
      }),
    );
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
    await store.applyAgentEvent(
      "session-g",
      eventEnvelope("session-g", "run-1", 1, {
        type: "run-state-changed",
        state: "completed",
        attempt: 1,
      }),
    );
    await store.clear("session-g");
    expect((await store.load("session-g")).messages).toEqual([]);
  });

  it("keeps the transcript revision monotonic across stale events and clear", async () => {
    const store = new MemoryConversationStore();
    await store.create("session-revision");
    await store.beginRun("session-revision", "run-1", {
      id: "user-1",
      role: "user",
      text: "question",
      images: [],
      status: "complete",
    });
    await store.applyAgentEvent(
      "session-revision",
      eventEnvelope("session-revision", "run-1", 3, {
        type: "text-delta",
        partId: "text-1",
        delta: "answer",
      }),
    );
    await store.applyAgentEvent(
      "session-revision",
      eventEnvelope("session-revision", "run-1", 2, {
        type: "text-delta",
        partId: "text-1",
        delta: "stale",
      }),
    );

    await expect(store.load("session-revision")).resolves.toMatchObject({
      eventRevision: 3,
      messages: [expect.anything(), expect.objectContaining({ text: "answer" })],
    });
    await store.applyAgentEvent(
      "session-revision",
      eventEnvelope("session-revision", "run-1", 4, {
        type: "run-state-changed",
        state: "completed",
        attempt: 1,
      }),
    );
    await store.clear("session-revision", 1);
    await expect(store.load("session-revision")).resolves.toMatchObject({
      eventRevision: 4,
      messages: [],
    });
  });

  it("rejects an event envelope addressed to another conversation", async () => {
    const store = new MemoryConversationStore();
    await store.create("session-a");
    await expect(
      store.applyAgentEvent("session-a", eventEnvelope("session-b", "run-1", 1, { type: "start" })),
    ).rejects.toThrow("事件不属于当前会话");
  });
});
