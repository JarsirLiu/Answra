import {
  AgentRuntime,
  agentId,
  CONVERSATION_AGENT_ID,
  CONVERSATION_TEAM_ID,
  ConversationApplication,
  createBotCatalog,
  createBuiltinToolRegistry,
  createConversationBot,
  createConversationBots,
  MemoryConversationStore,
  MemoryExecutionStore,
} from "@answra/agent/composition";
import { describe, expect, it } from "vitest";

function createComposition() {
  const agentRuntime = new AgentRuntime({
    executionStore: new MemoryExecutionStore(),
    emitEvent: () => {},
  });
  return {
    agentRuntime,
    store: new MemoryConversationStore(),
    tools: createBuiltinToolRegistry(),
  };
}

describe("public composition entry", () => {
  it("assembles the built-in conversation bot and application", async () => {
    const { agentRuntime, store, tools } = createComposition();
    const catalog = createBotCatalog(createConversationBots({ agentRuntime, store, tools }));
    const app = new ConversationApplication({ agentRuntime, store, catalog });

    expect(app.listBots().map((bot) => bot.id)).toEqual([CONVERSATION_AGENT_ID]);

    const snapshot = await app.createConversation("cli-builtin");
    expect(snapshot.activeAgentId).toBe(CONVERSATION_AGENT_ID);
    expect(snapshot.participantAgentIds).toEqual([CONVERSATION_AGENT_ID]);

    agentRuntime.dispose();
  });

  it("accepts a client-owned conversation bot", async () => {
    const { agentRuntime, store, tools } = createComposition();
    const customId = agentId("conversation.cli");
    const customBot = createConversationBot({
      agentRuntime,
      store,
      tools,
      id: customId,
      identity: {
        name: "CLI 助手",
        role: "cli",
        responsibility: "在命令行中处理对话任务",
        owns: ["cli"],
      },
      discovery: { visibleTo: { kind: "team", teamId: CONVERSATION_TEAM_ID } },
    });
    const catalog = createBotCatalog([
      ...createConversationBots({ agentRuntime, store, tools }),
      customBot,
    ]);
    const app = new ConversationApplication({ agentRuntime, store, catalog });

    expect(app.listBots().map((bot) => bot.id)).toContain(customId);

    const snapshot = await app.createConversation("cli-custom", {
      kind: "bot",
      botId: customId,
    });
    expect(snapshot.activeAgentId).toBe(customId);
    expect(snapshot.participantAgentIds).toEqual([customId]);

    agentRuntime.dispose();
  });
});
