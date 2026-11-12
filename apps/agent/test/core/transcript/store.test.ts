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

describe("memory conversation team metadata and handoff", () => {
  const seed = {
    activeAgentId: "candidate",
    participantAgentIds: ["candidate", "intake"],
    bots: [
      { id: "candidate", name: "候选人", role: "candidate" },
      { id: "intake", name: "面试向导", role: "intake" },
    ],
  } as const;

  it("seeds active Bot, participants and display identity", async () => {
    const store = new MemoryConversationStore();
    const snapshot = await store.create("team", seed);

    expect(snapshot).toMatchObject({
      activeAgentId: "candidate",
      participantAgentIds: ["candidate", "intake"],
      bots: [
        { id: "candidate", name: "候选人", role: "candidate" },
        { id: "intake", name: "面试向导", role: "intake" },
      ],
    });
  });

  it("keeps an existing conversation's seed when create is called again", async () => {
    const store = new MemoryConversationStore();
    await store.create("team", seed);
    await store.create("team", {
      activeAgentId: "other",
      participantAgentIds: ["other"],
      bots: [{ id: "other", name: "其他", role: "other" }],
    });

    await expect(store.load("team")).resolves.toMatchObject({
      activeAgentId: "candidate",
      participantAgentIds: ["candidate", "intake"],
      bots: [
        { id: "candidate", name: "候选人", role: "candidate" },
        { id: "intake", name: "面试向导", role: "intake" },
      ],
    });

    await store.clear("team");
    await expect(store.load("team")).resolves.toMatchObject({
      activeAgentId: "candidate",
      participantAgentIds: ["candidate", "intake"],
      messages: [],
    });
  });

  it("attributes the user message and assistant placeholder to the speaking Bot", async () => {
    const store = new MemoryConversationStore();
    await store.create("team", seed);
    await store.beginRun(
      "team",
      "run-1",
      {
        id: "user-1",
        role: "user",
        text: "帮我准备面试",
        images: [],
        status: "complete",
      },
      0,
      "candidate",
    );

    const snapshot = await store.load("team");
    expect(snapshot.activeAgentId).toBe("candidate");
    expect(snapshot.messages[0]).toMatchObject({
      role: "user",
      audience: { kind: "user" },
    });
    expect(snapshot.messages[1]).toMatchObject({
      role: "assistant",
      authorAgentId: "candidate",
      audience: { kind: "user" },
      status: "streaming",
    });
  });

  it("appends a handoff without advancing the event revision and claims it for the target", async () => {
    const store = new MemoryConversationStore();
    await store.create("team", seed);
    await store.beginRun(
      "team",
      "run-1",
      { id: "user-1", role: "user", text: "整理简历", images: [], status: "complete" },
      4,
      "candidate",
    );
    await store.applyAgentEvent(
      "team",
      eventEnvelope("team", "run-1", 5, {
        type: "run-state-changed",
        state: "completed",
        attempt: 1,
      }),
    );
    const before = await store.load("team");

    const appended = await store.appendHandoffMessage("team", {
      id: "handoff-1",
      fromAgentId: "candidate",
      toAgentId: "intake",
      task: "简历缺项目指标，请接管整理",
    });
    expect(appended.eventRevision).toBe(before.eventRevision);
    expect(appended.activeAgentId).toBe("intake");
    expect(appended.messages.at(-1)).toMatchObject({
      id: "handoff-1",
      role: "assistant",
      authorAgentId: "candidate",
      audience: { kind: "bot", agentId: "intake" },
      status: "complete",
      parts: [],
    });

    const claimed = await store.beginHandoffRun("team", "run-2", "intake", 5);
    expect(claimed).toMatchObject({ id: "handoff-1", text: "简历缺项目指标，请接管整理" });
    const snapshot = await store.load("team");
    expect(snapshot.activeRunId).toBe("run-2");
    expect(snapshot.activeAgentId).toBe("intake");
    expect(snapshot.eventRevision).toBe(before.eventRevision);
    expect(snapshot.messages.at(-1)).toMatchObject({
      id: "run-2",
      authorAgentId: "intake",
      audience: { kind: "user" },
      status: "streaming",
    });
  });

  it("rejects a handoff claim that is not addressed to the target", async () => {
    const store = new MemoryConversationStore();
    await store.create("team", seed);
    await store.beginRun(
      "team",
      "run-1",
      { id: "user-1", role: "user", text: "整理简历", images: [], status: "complete" },
      0,
      "candidate",
    );
    await store.applyAgentEvent(
      "team",
      eventEnvelope("team", "run-1", 1, {
        type: "run-state-changed",
        state: "completed",
        attempt: 1,
      }),
    );
    await store.appendHandoffMessage("team", {
      id: "handoff-1",
      fromAgentId: "candidate",
      toAgentId: "intake",
      task: "整理简历",
    });

    await expect(store.beginHandoffRun("team", "run-2", "candidate")).rejects.toThrow(
      "没有可接管给当前 Bot 的交接消息",
    );
  });

  it("validates handoff content and participants", async () => {
    const store = new MemoryConversationStore();
    await store.create("team", seed);

    await expect(
      store.appendHandoffMessage("team", {
        id: "handoff-1",
        fromAgentId: "candidate",
        toAgentId: "candidate",
        task: "x",
      }),
    ).rejects.toThrow("交接目标不能是当前 Bot");
    await expect(
      store.appendHandoffMessage("team", {
        id: "handoff-2",
        fromAgentId: "candidate",
        toAgentId: "intake",
        task: "   ",
      }),
    ).rejects.toThrow("交接内容无效或过长");
    await expect(
      store.appendHandoffMessage("team", {
        id: "handoff-3",
        fromAgentId: "candidate",
        toAgentId: "outsider",
        task: "整理简历",
      }),
    ).rejects.toThrow("Bot 不在当前会话参与者中");
    await expect(
      store.appendHandoffMessage("team", {
        id: "handoff-4",
        fromAgentId: "intake",
        toAgentId: "candidate",
        task: "越权交接",
      }),
    ).rejects.toThrow("交接来源必须是当前 Bot");
  });

  it("clears messages but restores the entry Bot and participants", async () => {
    const store = new MemoryConversationStore();
    await store.create("team", seed);
    await store.beginRun(
      "team",
      "run-1",
      { id: "user-1", role: "user", text: "整理简历", images: [], status: "complete" },
      0,
      "candidate",
    );
    await store.applyAgentEvent(
      "team",
      eventEnvelope("team", "run-1", 1, {
        type: "run-state-changed",
        state: "completed",
        attempt: 1,
      }),
    );
    await store.setActiveAgent("team", "intake");
    await store.clear("team", 6);

    const snapshot = await store.load("team");
    expect(snapshot.messages).toEqual([]);
    expect(snapshot.activeAgentId).toBe("candidate");
    expect(snapshot.participantAgentIds).toEqual(["candidate", "intake"]);
    expect(snapshot.bots).toHaveLength(2);
    expect(snapshot.eventRevision).toBe(6);
  });

  it("rejects an unknown active Bot", async () => {
    const store = new MemoryConversationStore();
    await store.create("team", seed);
    await expect(store.setActiveAgent("team", "outsider")).rejects.toThrow(
      "Bot 不在当前会话参与者中",
    );
  });
});
