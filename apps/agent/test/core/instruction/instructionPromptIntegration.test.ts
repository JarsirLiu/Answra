import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODING_AGENT_ID,
  createAgentDefinition as createCodingAgentDefinition,
} from "../../../src/bots/coding/agent";
import { CODING_POLICY } from "../../../src/bots/coding/policy";
import {
  GENERAL_AGENT_ID as CONVERSATION_AGENT_ID,
  createAgentDefinition as createConversationAgentDefinition,
} from "../../../src/bots/general/agent";
import { CHAT_PROFILES } from "../../../src/bots/general/profile";
import { createBuiltinToolRegistry } from "../../../src/core/tool";
import { MemoryConversationStore } from "../../../src/core/transcript/memoryStore";
import { createUserMessage } from "../../../src/core/transcript/message";

const tempRoots: string[] = [];

async function makeWorkspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "answra-instruction-prompt-"));
  tempRoots.push(root);
  await fs.writeFile(path.join(root, "AGENTS.md"), "先写测试再改代码。", "utf8");
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("AGENTS.md reaches agent system prompts", () => {
  it("injects workspace instructions into the coding request", async () => {
    const workspaceRoot = await makeWorkspace();
    const store = new MemoryConversationStore();
    const tools = createBuiltinToolRegistry();
    const definition = createCodingAgentDefinition({ store, tools });
    const conversationId = "coding-instruction";
    const request = { text: "检查项目结构", images: [] };

    await store.create(conversationId, {
      activeAgentId: CODING_AGENT_ID,
      participantAgentIds: [CODING_AGENT_ID],
    });
    await store.beginSessionTurn(conversationId, {
      turnId: "turn-1",
      messageId: "run-1",
      userMessage: createUserMessage("user-1", request),
      authorAgentId: CODING_AGENT_ID,
    });
    const prepared = await definition.prepare(
      { conversationId, runId: "run-1", request, policy: CODING_POLICY, workspaceRoot },
      new AbortController().signal,
    );

    expect(prepared.system).toContain(
      `Instructions from: ${path.join(workspaceRoot, "AGENTS.md")}`,
    );
    expect(prepared.system).toContain("先写测试再改代码。");
    await tools.dispose();
  });

  it("injects workspace instructions into the conversation request", async () => {
    const workspaceRoot = await makeWorkspace();
    const store = new MemoryConversationStore();
    const tools = createBuiltinToolRegistry();
    const definition = createConversationAgentDefinition({ store, tools });
    const conversationId = "conversation-instruction";
    const request = { text: "看一下这个项目", images: [] };

    await store.create(conversationId, {
      activeAgentId: CONVERSATION_AGENT_ID,
      participantAgentIds: [CONVERSATION_AGENT_ID],
    });
    await store.beginSessionTurn(conversationId, {
      turnId: "turn-1",
      messageId: "run-1",
      userMessage: createUserMessage("user-1", request),
      authorAgentId: CONVERSATION_AGENT_ID,
    });
    const prepared = await definition.prepare(
      {
        conversationId,
        runId: "run-1",
        request,
        profile: CHAT_PROFILES["general-chat"],
        workspaceRoot,
      },
      new AbortController().signal,
    );

    expect(prepared.system).toContain(
      `Instructions from: ${path.join(workspaceRoot, "AGENTS.md")}`,
    );
    expect(prepared.system).toContain("先写测试再改代码。");
    await tools.dispose();
  });
});
