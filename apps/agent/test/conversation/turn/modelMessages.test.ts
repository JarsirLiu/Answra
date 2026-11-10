import type { ConversationMessage, ConversationSnapshot } from "@answra/shared";
import type { AgentEvent, AgentEventEnvelope } from "@answra/shared/schema";
import { describe, expect, it } from "vitest";
import { buildModelMessages } from "../../../src/conversation/turn/modelMessages";
import { MemoryConversationStore } from "../../../src/core/transcript/memoryStore";
import type { ConversationStore } from "../../../src/core/transcript/store";

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
    occurredAt: "2026-11-10T00:00:00.000Z",
    event,
  };
}

function request(text = "") {
  return { text, images: [] };
}

function legacyStore(messages: ConversationMessage[]): ConversationStore {
  const snapshot: ConversationSnapshot = {
    conversationId: "legacy",
    eventRevision: 0,
    messages,
  };
  return { load: async () => snapshot } as unknown as ConversationStore;
}

describe("conversation model messages", () => {
  it("replays assistant tool calls and results in model order", async () => {
    const store = new MemoryConversationStore();
    await store.create("tools");
    await store.beginRun("tools", "run-1", {
      id: "user-1",
      role: "user",
      text: "读取文件",
      images: [],
      status: "complete",
    });

    let revision = 0;
    const apply = async (event: AgentEvent): Promise<void> => {
      revision += 1;
      await store.applyAgentEvent("tools", eventEnvelope("tools", "run-1", revision, event));
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
    await apply({
      type: "tool-execution-started",
      toolCallId: "tool-1",
      toolName: "Read",
      input: { file_path: "a.ts" },
    });
    await apply({
      type: "tool-execution-finished",
      toolCallId: "tool-1",
      toolName: "Read",
      input: { file_path: "a.ts" },
      result: { success: true, output: "file-content" },
      durationMs: 1,
    });
    await apply({ type: "text-start", partId: "text-2" });
    await apply({ type: "text-delta", partId: "text-2", delta: "读取完成。" });
    await apply({ type: "text-end", partId: "text-2" });
    await apply({ type: "run-state-changed", state: "completed", attempt: 1 });

    const messages = await buildModelMessages({
      conversationId: "tools",
      request: request(),
      includeHistory: true,
      injectTime: false,
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
      injectTime: false,
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
      injectTime: false,
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
