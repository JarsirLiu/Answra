import { describe, expect, it } from "vitest";
import { CODING_AGENT_ID, createCodingAgentDefinition } from "../../src/coding/agent";
import { CODING_POLICY } from "../../src/coding/policy";
import { createBuiltinToolRegistry } from "../../src/core/tool";
import { MemoryConversationStore } from "../../src/core/transcript/memoryStore";
import { createUserMessage } from "../../src/core/transcript/message";
import { createExecutionEvent } from "../../src/execution/events";

describe("coding Agent", () => {
  it("uses its own identity, prompt, and coding tool set", async () => {
    const store = new MemoryConversationStore();
    const tools = createBuiltinToolRegistry();
    const definition = createCodingAgentDefinition({ store, tools });
    const conversationId = "coding-agent-test";
    const runId = "coding-run-1";
    const request = { text: "读取 README 并概述结构", images: [] };

    await store.create(conversationId, {
      activeAgentId: CODING_AGENT_ID,
      participantAgentIds: [CODING_AGENT_ID],
    });
    await store.beginRun(
      conversationId,
      runId,
      createUserMessage("coding-user-1", request),
      0,
      CODING_AGENT_ID,
    );

    const modelRequest = await definition.prepare(
      {
        conversationId,
        runId,
        request,
        policy: CODING_POLICY,
        workspaceRoot: "D:/coding-workspace",
      },
      new AbortController().signal,
    );

    expect(definition.id).toBe(CODING_AGENT_ID);
    expect(definition.modelRoute).toBe("chat");
    expect(modelRequest.system).toContain("命令行编码助手");
    expect(modelRequest.system).toContain("当前工作目录：D:/coding-workspace");
    expect(modelRequest.system).toContain("# 运行环境");
    expect(Object.keys(modelRequest.tools ?? {})).toEqual([
      "Read",
      "Grep",
      "Edit",
      "RunCommand",
      "WriteStdin",
    ]);
    expect(JSON.stringify(modelRequest.messages)).toContain("读取 README 并概述结构");
    expect(JSON.stringify(modelRequest.messages)).not.toContain("通用 AI 助手");

    await tools.dispose();
  });

  it("keeps conversation history in the coding request", async () => {
    const store = new MemoryConversationStore();
    const tools = createBuiltinToolRegistry();
    const definition = createCodingAgentDefinition({ store, tools });
    const conversationId = "coding-history-test";

    await store.create(conversationId, {
      activeAgentId: CODING_AGENT_ID,
      participantAgentIds: [CODING_AGENT_ID],
    });
    await store.beginRun(
      conversationId,
      "coding-run-1",
      createUserMessage("coding-user-1", { text: "我叫小明", images: [] }),
      0,
      CODING_AGENT_ID,
    );
    await store.applyAgentEvent(
      conversationId,
      createExecutionEvent(
        {
          runId: "coding-run-1",
          attemptId: "coding-attempt-1",
          conversationId,
          producerId: "test",
          sequence: 1,
          aggregateRevision: 1,
          occurredAt: new Date(0).toISOString(),
        },
        { type: "run-state-changed", state: "completed", attempt: 1 },
      ),
    );
    await store.beginRun(
      conversationId,
      "coding-run-2",
      createUserMessage("coding-user-2", { text: "我叫什么？", images: [] }),
      1,
      CODING_AGENT_ID,
    );

    const modelRequest = await definition.prepare(
      {
        conversationId,
        runId: "coding-run-2",
        request: { text: "我叫什么？", images: [] },
        policy: CODING_POLICY,
        workspaceRoot: "D:/coding-workspace",
      },
      new AbortController().signal,
    );

    const messages = JSON.stringify(modelRequest.messages);
    expect(messages).toContain("我叫小明");
    expect(messages).toContain("我叫什么？");

    await tools.dispose();
  });
});
