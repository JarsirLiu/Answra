/** Conversation Bot 装配入口；新增 Bot 时在这里注册，不修改会话编排。 */
import type { AgentRuntime } from "../../core/agent/runtime";
import type { InstructionLoader } from "../../core/instruction";
import type { SkillCatalog } from "../../core/skill/catalog";
import type { ToolRegistry } from "../../core/tool";
import type { ConversationStore } from "../../core/transcript/store";
import { createGeneralConversationBot } from "./general";
import type { ConversationBot } from "./types";

export { CONVERSATION_AGENT_ID, GENERAL_DISCOVERY, GENERAL_IDENTITY } from "../agent";
export { type ConversationBotOptions, createConversationBot } from "./create";
export type { ConversationBot, ConversationBotCatalog } from "./types";

export function createConversationBots({
  agentRuntime,
  store,
  tools,
  skills,
  instructions,
}: {
  agentRuntime: AgentRuntime;
  store: ConversationStore;
  tools: ToolRegistry;
  skills?: SkillCatalog;
  instructions?: InstructionLoader;
}): readonly ConversationBot[] {
  return [
    createGeneralConversationBot({
      agentRuntime,
      store,
      tools,
      ...(skills ? { skills } : {}),
      ...(instructions ? { instructions } : {}),
    }),
  ];
}
