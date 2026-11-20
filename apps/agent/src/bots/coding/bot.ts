/** Coding Bot 工厂：装配身份、执行器与 policy。 */
import type { AgentRuntime } from "../../core/agent/runtime";
import type { BotDescriptor } from "../../core/bot/contracts";
import type { InstructionLoader } from "../../core/instruction";
import type { SkillCatalog } from "../../core/skill/catalog";
import type { ToolRegistry } from "../../core/tool";
import type { ConversationStore } from "../../core/transcript/store";
import {
  CODING_AGENT_ID,
  CODING_DISCOVERY,
  CODING_IDENTITY,
  type CodingAgentInput,
  createAgentDefinition,
} from "./agent";
import { CODING_POLICY, type CodingPolicy } from "./policy";

export type CodingBot = BotDescriptor<CodingAgentInput, CodingPolicy>;

export function createCodingBot({
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
}): CodingBot {
  const definition = createAgentDefinition({
    store,
    tools,
    ...(skills ? { skills } : {}),
    ...(instructions ? { instructions } : {}),
  });
  return {
    id: CODING_AGENT_ID,
    identity: CODING_IDENTITY,
    discovery: CODING_DISCOVERY,
    domain: "coding",
    executor: agentRuntime.registerAgent(definition),
    policy: CODING_POLICY,
  };
}
