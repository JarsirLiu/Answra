import type { ConversationMessage, ConversationSnapshot } from "@answra/shared";
import type { AgentStreamEvent } from "@answra/shared/schema";
import { describe, expect, it } from "vitest";
import { buildModelMessages } from "../../../src/conversation/turn/modelMessages";
import { MemoryConversationStore } from "../../../src/core/transcript/memoryStore";
import type { ConversationStore } from "../../../src/core/transcript/store";

function request(text = "") {
  return { text, images: [] };
}

function legacyStore(messages: ConversationMessage[]): ConversationStore {
  const snapshot: ConversationSnapshot = {
    conversationId: "legacy",
    lastSeq: 0,
    messages,
  };
  return {
    load: async () => snapshot,
    loadContextState: async () => undefined,
  } as unknown as ConversationStore;
}

describe("conversation model messages", () => {
  it("replays assistant tool calls and results in model order", async () => {
    const store = new MemoryConversationStore();
    await store.create("tools");
    await store.beginSessionTurn("tools", {
      turnId: "turn-1",
      messageId: "run-1",
      authorAgentId: "general",
      userMessage: {
        id: "user-1",
        role: "user",
        text: "读取文件",
        images: [],
        status: "complete",
      },
    });

    const apply = async (event: AgentStreamEvent): Promise<void> => {
      await store.applySessionStreamEvent("tools", "run-1", event);
    };

    await apply({ type: "text-start", partId: "text-1" });
    await apply({ type: "text-delta", partId: "text-1", delta: "先读取。" });
    await apply({ type: "text-end", partId: "text-1" });
    await apply({
      type: "tool-call",
      toolCallId: "tool-1",
      toolName: "Read",
      input: { file_path: "a.ts" },
    });
    await apply({ type: "tool-result", toolCallId: "tool-1", output: "file-content" });
    await apply({ type: "text-start", partId: "text-2" });
    await apply({ type: "text-delta", partId: "text-2", delta: "读取完成。" });
    await apply({ type: "text-end", partId: "text-2" });
    await store.finishSessionAssistant("tools", "run-1", "completed");
    await store.finishSessionTurn("tools", "turn-1");

    const messages = await buildModelMessages({
      conversationId: "tools",
      request: request(),
      includeHistory: true,
      store,
    });

    expect(messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "读取文件" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "先读取。" },
          {
            type: "tool-call",
            toolCallId: "tool-1",
            toolName: "Read",
            input: { file_path: "a.ts" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tool-1",
            toolName: "Read",
            output: { type: "text", value: "file-content" },
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "读取完成。" }],
      },
    ]);
  });

  it("keeps failed and interrupted tool calls paired with explicit results", async () => {
    const messages = await buildModelMessages({
      conversationId: "legacy",
      request: request(),
      includeHistory: true,
      store: legacyStore([
        {
          id: "user-1",
          role: "user",
          text: "处理",
          images: [],
          status: "complete",
        },
        {
          id: "run-1",
          role: "assistant",
          text: "结束",
          images: [],
          status: "complete",
          parts: [
            {
              id: "tool-1",
              kind: "tool",
              toolCallId: "tool-1",
              toolName: "Read",
              state: "failed",
              input: { file_path: "missing.ts" },
              errorText: "文件不存在",
            },
            {
              id: "tool-2",
              kind: "tool",
              toolCallId: "tool-2",
              toolName: "Grep",
              state: "interrupted",
              input: { pattern: "needle" },
            },
            { id: "text-1", kind: "text", text: "结束", state: "completed" },
          ],
        },
      ]),
    });

    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "tool-1" },
        { type: "tool-call", toolCallId: "tool-2" },
      ],
    });
    expect(messages[2]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "tool-1",
          toolName: "Read",
          output: { type: "text", value: "文件不存在" },
        },
        {
          type: "tool-result",
          toolCallId: "tool-2",
          toolName: "Grep",
          output: { type: "text", value: "工具执行被中断，没有返回结果。" },
        },
      ],
    });
    expect(messages[3]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "结束" }],
    });
  });

  it("falls back to assistant text when an old message has no parts", async () => {
    const messages = await buildModelMessages({
      conversationId: "legacy",
      request: request(),
      includeHistory: true,
      store: legacyStore([
        {
          id: "run-1",
          role: "assistant",
          text: "旧回复",
          images: [],
          status: "complete",
        },
      ]),
    });

    expect(messages).toEqual([{ role: "assistant", content: "旧回复" }]);
  });
});
