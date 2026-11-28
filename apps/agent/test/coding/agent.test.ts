import { describe, expect, it } from "vitest";
import { CODING_AGENT_ID, createCodingAgentDefinition } from "../../src/coding/agent";
import { CODING_POLICY } from "../../src/coding/policy";
import { createBuiltinToolRegistry } from "../../src/core/tool";
import { MemoryConversationStore } from "../../src/core/transcript/memoryStore";
import { createUserMessage } from "../../src/core/transcript/message";

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
    await store.beginSessionTurn(conversationId, {
      turnId: runId,
      messageId: runId,
      userMessage: createUserMessage("coding-user-1", request),
      authorAgentId: CODING_AGENT_ID,
    });

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
      "WebSearch",
      "WebFetch",
    ]);
    expect(JSON.stringify(modelRequest.messages)).toContain("读取 README 并概述结构");
    expect(JSON.stringify(modelRequest.messages)).not.toContain("通用 AI 助手");

    await tools.dispose();
  });
});
