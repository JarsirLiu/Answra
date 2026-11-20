/** General conversation Bot 工厂：装配身份、执行器与 profile。 */
import type {
  AgentId,
  BotDiscovery,
  BotIdentity,
  BotTurnResult,
} from "../../core/agent/definition";
import type { AgentRuntime } from "../../core/agent/runtime";
import type { BotDescriptor } from "../../core/bot/contracts";
import type { InstructionLoader } from "../../core/instruction";
import type { SkillCatalog } from "../../core/skill/catalog";
import type { ToolRegistry } from "../../core/tool";
import type { ConversationStore } from "../../core/transcript/store";
import {
  type ConversationAgentInput,
  type ConversationAgentProfile,
  createAgentDefinition,
  GENERAL_AGENT_ID,
  GENERAL_DISCOVERY,
  GENERAL_IDENTITY,
} from "./agent";
import { CHAT_PROFILES } from "./profile";

export type ConversationBot = BotDescriptor<ConversationAgentInput, ConversationAgentProfile>;

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

export function createGeneralBot({
  agentRuntime,
  store,
  tools,
  skills,
  instructions,
  id = GENERAL_AGENT_ID,
  identity = GENERAL_IDENTITY,
  discovery = GENERAL_DISCOVERY,
  profile = CHAT_PROFILES["general-chat"],
  result,
}: ConversationBotOptions): ConversationBot {
  const definition = createAgentDefinition({
    store,
    tools,
    ...(skills ? { skills } : {}),
    ...(instructions ? { instructions } : {}),
    id,
    identity,
    discovery,
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
