import {
  type ConversationAgentInput,
  type ConversationAgentProfile,
  createAgentDefinition,
} from "../../bots/general/agent";
import { CHAT_PROFILES } from "../../bots/general/profile";
import type {
  AgentId,
  BotDiscovery,
  BotIdentity,
  BotTurnResult,
} from "../../core/agent/definition";
import type { AgentRuntime } from "../../core/agent/runtime";
import type { InstructionLoader } from "../../core/instruction";
import type { SkillCatalog } from "../../core/skill/catalog";
import type { ToolRegistry } from "../../core/tool";
import type { ConversationStore } from "../../core/transcript/store";
import type { ConversationBot } from "./types";

export interface ConversationBotOptions {
  agentRuntime: AgentRuntime;
  store: ConversationStore;
  tools: ToolRegistry;
  skills?: SkillCatalog;
  instructions?: InstructionLoader;
  id?: AgentId;
  identity?: BotIdentity;
  discovery?: BotDiscovery;
  profile?: ConversationAgentProfile;
  result?: (input: ConversationAgentInput, runId: string) => Promise<BotTurnResult | undefined>;
}

export function createConversationBot({
  agentRuntime,
  store,
  tools,
  skills,
  instructions,
  id,
  identity,
  discovery,
  profile = CHAT_PROFILES["general-chat"],
  result,
}: ConversationBotOptions): ConversationBot {
  const definition = createAgentDefinition({
    store,
    tools,
    ...(skills ? { skills } : {}),
    ...(instructions ? { instructions } : {}),
    ...(id ? { id } : {}),
    ...(identity ? { identity } : {}),
    ...(discovery ? { discovery } : {}),
    profile,
    ...(result ? { result } : {}),
  });
  return {
    id: definition.id,
    identity: definition.identity,
    discovery: definition.discovery,
    domain: "conversation",
    executor: agentRuntime.registerAgent(definition),
    policy: profile,
  };
}
