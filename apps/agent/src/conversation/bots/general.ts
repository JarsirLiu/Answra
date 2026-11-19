import type { AgentRuntime } from "../../core/agent/runtime";
import type { InstructionLoader } from "../../core/instruction";
import type { SkillCatalog } from "../../core/skill/catalog";
import type { ToolRegistry } from "../../core/tool";
import type { ConversationStore } from "../../core/transcript/store";
import { createConversationBot } from "./create";
import type { ConversationBot } from "./types";

export function createGeneralConversationBot({
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
}): ConversationBot {
  return createConversationBot({
    agentRuntime,
    store,
    tools,
    ...(skills ? { skills } : {}),
    ...(instructions ? { instructions } : {}),
  });
}
