/** Bot 注册中心：统一工厂接口与依赖注入。 */
import type { AgentRuntime } from "../core/agent/runtime";
import type { InstructionLoader } from "../core/instruction";
import type { SkillCatalog } from "../core/skill/catalog";
import type { ToolRegistry } from "../core/tool";
import type { ConversationStore } from "../core/transcript/store";
import { type CodingBot, createCodingBot } from "./coding/bot";
import { type ConversationBot, createGeneralBot } from "./general/bot";

export interface BotFactoryDeps {
  agentRuntime: AgentRuntime;
  store: ConversationStore;
  tools: ToolRegistry;
  skills?: SkillCatalog;
  instructions?: InstructionLoader;
}

export function createGeneralConversationBot(deps: BotFactoryDeps): ConversationBot {
  return createGeneralBot(deps);
}

export type { CodingBot, ConversationBot };
export { createCodingBot };
