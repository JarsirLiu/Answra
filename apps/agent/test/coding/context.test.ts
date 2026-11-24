/** Coding 模型上下文：项目循环的下一 Step 必须看到本 Turn 已有工具往返。 */
import { describe, expect, it } from "vitest";
import { buildCodingMessages } from "../../src/coding/context";
import { MemoryConversationStore } from "../../src/core/transcript/memoryStore";

const request = { text: "改一下", images: [] };

async function storeWithFinishedSkillCall(): Promise<MemoryConversationStore> {
  const store = new MemoryConversationStore();
  await store.create("conversation");
  await store.beginSessionTurn("conversation", {
    turnId: "turn-1",
    messageId: "assistant-1",
    authorAgentId: "coding.engineer",
    userMessage: { id: "user-1", role: "user", text: request.text, images: [], status: "complete" },
  });
  await store.applySessionStreamEvent("conversation", "assistant-1", {
    type: "tool-call",
    toolCallId: "call-1",
    toolName: "Skill",
    input: { name: "answra-code" },
  });
  await store.applySessionStreamEvent("conversation", "assistant-1", {
    type: "tool-execution-started",
    toolCallId: "call-1",
    toolName: "Skill",
    input: { name: "answra-code" },
  });
  await store.applySessionStreamEvent("conversation", "assistant-1", {
    type: "tool-execution-finished",
    toolCallId: "call-1",
    toolName: "Skill",
    input: { name: "answra-code" },
    result: { success: true, output: "<skill_content/>" },
    durationMs: 3,
  });
  return store;
}

describe("buildCodingMessages", () => {
  it("replays the in-flight turn's tool call and result into the next step", async () => {
    const store = await storeWithFinishedSkillCall();

    const messages = await buildCodingMessages({
      conversationId: "conversation",
      request,
      includeHistory: true,
      store,
    });

    expect(messages).toEqual([
      { role: "user", content: [{ type: "text", text: request.text }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "Skill",
            input: { name: "answra-code" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "Skill",
            output: { type: "text", value: "<skill_content/>" },
          },
        ],
      },
    ]);
  });

  it("keeps the user request as the only message before the first step", async () => {
    const store = new MemoryConversationStore();
    await store.create("conversation");
    await store.beginSessionTurn("conversation", {
      turnId: "turn-1",
      messageId: "assistant-1",
      authorAgentId: "coding.engineer",
      userMessage: {
        id: "user-1",
        role: "user",
        text: request.text,
        images: [],
        status: "complete",
      },
    });

    const messages = await buildCodingMessages({
      conversationId: "conversation",
      request,
      includeHistory: true,
      store,
    });

    expect(messages).toEqual([{ role: "user", content: [{ type: "text", text: request.text }] }]);
  });

  it("reads no history when the Bot does not include it", async () => {
    const store = await storeWithFinishedSkillCall();

    const messages = await buildCodingMessages({
      conversationId: "conversation",
      request,
      includeHistory: false,
      store,
    });

    expect(messages).toEqual([{ role: "user", content: [{ type: "text", text: request.text }] }]);
  });
});
