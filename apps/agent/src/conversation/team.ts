/** Conversation 团队装配：Bot 定义、执行器、profile 与目录校验的组合，不持有会话状态。 */
import type { AgentExecutor, AgentId, BotDiscovery, BotIdentity } from "../core/agent/definition";
import type { TeamCatalog, TeamDefinition } from "../core/team/types";
import type { ConversationAgentInput } from "./agent";
import type { ChatProfile } from "./profiles/registry";

export interface ConversationBot {
  agentId: AgentId;
  identity: BotIdentity;
  discovery: BotDiscovery;
  executor: AgentExecutor<ConversationAgentInput>;
  profile: ChatProfile;
}

export interface ConversationTeam {
  definition: TeamDefinition;
  bots: ReadonlyMap<AgentId, ConversationBot>;
}

export interface ConversationTeamInput {
  teamId: string;
  entryAgentId: AgentId;
  bots: readonly ConversationBot[];
}

export function createConversationTeam(input: ConversationTeamInput): ConversationTeam {
  const bots = new Map(input.bots.map((bot) => [bot.agentId, bot]));
  const definition: TeamDefinition = {
    teamId: input.teamId,
    entryAgentId: input.entryAgentId,
    memberAgentIds: input.bots.map((bot) => bot.agentId),
  };
  return { definition, bots };
}

/** 由所有已装配团队生成只读目录；启动期校验与交接运行期共用同一来源。 */
export function createTeamCatalog(teams: readonly ConversationTeam[]): TeamCatalog {
  const byId = new Map(teams.map((team) => [team.definition.teamId, team]));
  return {
    require(agentId) {
      for (const team of teams) {
        const bot = team.bots.get(agentId);
        if (bot) return { identity: bot.identity, discovery: bot.discovery };
      }
      throw new Error(`Bot 未注册：${agentId}`);
    },
    isMember(teamId, agentId) {
      const team = byId.get(teamId);
      return team?.definition.memberAgentIds.includes(agentId) ?? false;
    },
    hasTeam(teamId) {
      return byId.has(teamId);
    },
  };
}
