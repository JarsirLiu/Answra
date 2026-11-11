/** 团队静态定义与目录策略；不持有 transcript、不创建 run、不依赖任何领域。 */
import type { AgentId, BotDiscovery, BotIdentity } from "../agent/definition";

export interface TeamDefinition {
  teamId: string;
  entryAgentId: AgentId;
  memberAgentIds: readonly AgentId[];
}

/** 目录项只携带注册期身份；展示名和职责不复制到团队定义。 */
export interface TeamMemberView {
  agentId: AgentId;
  identity: BotIdentity;
  discovery: BotDiscovery;
}

/** AgentRegistry 或测试替身提供的只读目录来源。 */
export interface TeamCatalog {
  require(agentId: AgentId): { identity: BotIdentity; discovery: BotDiscovery };
  isMember(teamId: string, agentId: AgentId): boolean;
  hasTeam(teamId: string): boolean;
}
