/** CLI coding Bot 描述符：把独立身份、policy 与已注册执行器装配成 Bot。 */
import type { AgentRuntime } from "../core/agent/runtime";
import type { BotDescriptor } from "../core/bot/contracts";
import type { ToolRegistry } from "../core/tool";
import type { ConversationStore } from "../core/transcript/store";
import {
  CODING_AGENT_ID,
  CODING_DISCOVERY,
  CODING_IDENTITY,
  type CodingAgentInput,
  createCodingAgentDefinition,
} from "./agent";
import { CODING_POLICY, type CodingPolicy } from "./policy";

export type CodingBot = BotDescriptor<CodingAgentInput, CodingPolicy>;

export function createCodingBot({
  agentRuntime,
  store,
  tools,
}: {
  agentRuntime: AgentRuntime;
  store: ConversationStore;
  tools: ToolRegistry;
}): CodingBot {
  const definition = createCodingAgentDefinition({ store, tools });
  return {
    id: CODING_AGENT_ID,
    identity: CODING_IDENTITY,
    discovery: CODING_DISCOVERY,
    domain: "coding",
    executor: agentRuntime.registerAgent(definition),
    policy: CODING_POLICY,
  };
}
