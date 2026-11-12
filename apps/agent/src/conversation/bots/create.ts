import type {
  AgentId,
  BotDiscovery,
  BotIdentity,
  BotTurnResult,
} from "../../core/agent/definition";
import type { AgentRuntime } from "../../core/agent/runtime";
import type { ToolRegistry } from "../../core/tool";
import type { ConversationStore } from "../../core/transcript/store";
import {
  type ConversationAgentInput,
  type ConversationAgentProfile,
  createConversationAgentDefinition,
} from "../agent";
import { CHAT_PROFILES } from "../profiles/registry";
import type { ConversationBot } from "./types";

export interface ConversationBotOptions {
  agentRuntime: AgentRuntime;
  store: ConversationStore;
  tools: ToolRegistry;
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
  id,
  identity,
  discovery,
  profile = CHAT_PROFILES["general-chat"],
  result,
}: ConversationBotOptions): ConversationBot {
  const definition = createConversationAgentDefinition({
    store,
    tools,
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
