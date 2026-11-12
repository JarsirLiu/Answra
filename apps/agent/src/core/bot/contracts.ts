/** Bot 静态契约：身份、发现、领域策略与目录项；不持有 transcript 或会话状态。 */
import type { BotSummary } from "@answra/shared";
import type { AgentExecutor, AgentId } from "../agent/definition";

export type { BotSummary } from "@answra/shared";
export type {
  BotDiscovery,
  BotIdentity,
  BotTurnResult,
  BotVisibility,
} from "../agent/definition";

import type { BotDiscovery, BotIdentity } from "../agent/definition";

export type BotDomain = "conversation" | "interview" | "answer" | "coding";

/** 领域装配单元：执行器和领域策略由领域提供，目录只负责查找。 */
export interface BotDescriptor<Input, Policy> {
  id: AgentId;
  identity: BotIdentity;
  discovery: BotDiscovery;
  domain: BotDomain;
  executor: AgentExecutor<Input>;
  policy: Policy;
}

/** 可见性校验需要的团队归属来源；由 core/team 的预置实现提供。 */
export interface BotTeamLookup {
  hasTeam(teamId: string): boolean;
  isMember(teamId: string, agentId: string): boolean;
}

export function summarizeBot(bot: { id: AgentId; identity: BotIdentity }): BotSummary {
  return {
    id: bot.id,
    name: bot.identity.name,
    role: bot.identity.role,
    responsibility: bot.identity.responsibility,
    owns: [...bot.identity.owns],
  };
}
