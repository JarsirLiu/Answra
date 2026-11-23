import { describe, expect, it } from "vitest";
import { MemoryConversationStore } from "../../../src/core/transcript/memoryStore";

const userMessage = (id: string, text = "question") => ({
  id,
  role: "user" as const,
  text,
  images: [],
  status: "complete" as const,
});

describe("memory conversation transcript store", () => {
  it("appends user messages and creates an assistant placeholder for a turn", async () => {
    const store = new MemoryConversationStore();
    await store.create("conversation");
    await store.appendUserMessage("conversation", userMessage("user-0", "hello"));
    await store.beginSessionTurn("conversation", {
      turnId: "turn-1",
      messageId: "assistant-1",
      authorAgentId: "general",
      userMessage: userMessage("user-1"),
    });

    await expect(store.load("conversation")).resolves.toMatchObject({
      activeTurnId: "turn-1",
      activeMessageId: "assistant-1",
      messages: [
        { id: "user-0", text: "hello", status: "complete" },
        { id: "user-1", role: "user", status: "complete" },
        { id: "assistant-1", role: "assistant", status: "streaming", authorAgentId: "general" },
      ],
    });
  });

  it("projects context checkpoint boundaries without storing them as messages", async () => {
    const store = new MemoryConversationStore();
    await store.create("compacted");
    await store.appendUserMessage("compacted", userMessage("user-1"));
    await store.saveContextState("compacted", {
      checkpoints: [
        {
          summary: "private summary",
          throughMessageId: "user-1",
          createdAt: "2026-11-14T10:00:01.000Z",
          messageCount: 1,
          instructions: "保留迁移决定",
        },
      ],
    });

    await expect(store.load("compacted")).resolves.toMatchObject({
      messages: [{ id: "user-1" }],
      contextCompactionBoundaries: [
        {
          throughMessageId: "user-1",
          summary: "private summary",
          summarizedMessages: 1,
          instructions: "保留迁移决定",
        },
      ],
    });
  });

  it("projects stream events and closes assistant messages by outcome", async () => {
    const store = new MemoryConversationStore();
    await store.create("stream");
    await store.beginSessionTurn("stream", {
      turnId: "turn-1",
      messageId: "assistant-1",
      authorAgentId: "general",
      userMessage: userMessage("user-1"),
    });
    await store.applySessionStreamEvent("stream", "assistant-1", {
      type: "text-delta",
      partId: "text-1",
      delta: "answer",
    });
    await store.applySessionStreamEvent("stream", "assistant-1", {
      type: "text-end",
      partId: "text-1",
    });
    await store.applySessionStreamEvent("stream", "assistant-1", {
      type: "reasoning-start",
      partId: "reason-1",
    });
    await store.applySessionStreamEvent("stream", "assistant-1", {
      type: "reasoning-delta",
      partId: "reason-1",
      delta: "think",
    });
    await store.applySessionStreamEvent("stream", "assistant-1", {
      type: "reasoning-end",
      partId: "reason-1",
    });
    await store.applySessionStreamEvent("stream", "assistant-1", {
      type: "tool-call",
      toolCallId: "tool-1",
      toolName: "Search",
      input: { query: "topic" },
    });
    await store.applySessionStreamEvent("stream", "assistant-1", {
      type: "tool-result",
      toolCallId: "tool-1",
      output: "result",
    });
    await store.finishSessionAssistant("stream", "assistant-1", "completed");
    await store.finishSessionTurn("stream", "turn-1");

    await expect(store.load("stream")).resolves.toMatchObject({
      activeMessageId: undefined,
      messages: [
        { id: "user-1" },
        {
          id: "assistant-1",
          text: "answer",
          reasoning: "think",
          status: "complete",
          parts: [
            { id: "text-1", kind: "text", text: "answer", state: "completed" },
            { id: "reason-1", kind: "reasoning", text: "think", state: "completed" },
            {
              id: "tool-1",
              kind: "tool",
              toolName: "Search",
              state: "completed",
              output: "result",
            },
          ],
        },
      ],
    });
  });

  it.each([
    ["failed", "failed"],
    ["aborted", "interrupted"],
  ] as const)(
    "settles unfinished parts when the assistant outcome is %s",
    async (outcome, state) => {
      const store = new MemoryConversationStore();
      await store.create("terminal");
      await store.beginSessionTurn("terminal", {
        turnId: "turn-1",
        messageId: "assistant-1",
        authorAgentId: "general",
        userMessage: userMessage("user-1"),
      });
      await store.applySessionStreamEvent("terminal", "assistant-1", {
        type: "text-start",
        partId: "text-1",
      });
      await store.applySessionStreamEvent("terminal", "assistant-1", {
        type: "tool-call",
        toolCallId: "tool-1",
        toolName: "Search",
        input: {},
      });
      await store.finishSessionAssistant("terminal", "assistant-1", outcome);

      await expect(store.load("terminal")).resolves.toMatchObject({
        messages: [
          expect.anything(),
          {
            status: state,
            parts: [
              { id: "text-1", state },
              { id: "tool-1", state },
            ],
          },
        ],
      });
    },
  );

  it("advances the durable cursor monotonically and resets it on clear", async () => {
    const store = new MemoryConversationStore();
    await store.create("cursor");
    await store.advanceLastSeq("cursor", 3);
    await store.advanceLastSeq("cursor", 2);
    expect((await store.load("cursor")).lastSeq).toBe(3);
    await store.advanceLastSeq("cursor", 4);
    await store.clear("cursor");
    expect((await store.load("cursor")).lastSeq).toBe(0);
    await expect(store.advanceLastSeq("cursor", -1)).rejects.toThrow("非负整数");
  });

  it("clears only when idle and preserves the seeded Bot roster", async () => {
    const store = new MemoryConversationStore();
    const seed = {
      activeAgentId: "candidate",
      participantAgentIds: ["candidate", "intake"],
      bots: [
        { id: "candidate", name: "Candidate", role: "candidate" },
        { id: "intake", name: "Intake", role: "intake" },
      ],
    };
    await store.create("team", seed);
    await store.beginSessionTurn("team", {
      turnId: "turn-1",
      messageId: "assistant-1",
      authorAgentId: "candidate",
      userMessage: userMessage("user-1"),
    });
    await store.clear("team");
    expect((await store.load("team")).activeMessageId).toBe("assistant-1");
    await store.finishSessionAssistant("team", "assistant-1", "completed");
    await store.finishSessionTurn("team", "turn-1");
    await store.setActiveAgent("team", "intake");
    await store.clear("team");
    await expect(store.load("team")).resolves.toMatchObject({
      messages: [],
      activeAgentId: "candidate",
      participantAgentIds: ["candidate", "intake"],
      bots: seed.bots,
    });
  });

  it("writes a handoff message and opens the target assistant message", async () => {
    const store = new MemoryConversationStore();
    await store.create("team", {
      activeAgentId: "candidate",
      participantAgentIds: ["candidate", "intake"],
    });
    const handoff = await store.appendHandoffMessage("team", {
      id: "handoff-1",
      fromAgentId: "candidate",
      toAgentId: "intake",
      task: "整理资料",
    });
    expect(handoff.messages.at(-1)).toMatchObject({
      id: "handoff-1",
      audience: { kind: "bot", agentId: "intake" },
      status: "complete",
    });
    await store.beginSessionAssistant("team", "assistant-2", "intake");
    await expect(store.load("team")).resolves.toMatchObject({
      activeAgentId: "intake",
      activeMessageId: "assistant-2",
      messages: [
        expect.objectContaining({ id: "handoff-1" }),
        { id: "assistant-2", authorAgentId: "intake" },
      ],
    });
  });
});
