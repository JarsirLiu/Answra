/** Agent 的启动期静态注册表；保存身份/发现策略并拒绝重复与悬空引用。 */
import type { AgentId, BotDiscovery, BotIdentity } from "./definition";

export interface RegisteredAgentInfo {
  identity: BotIdentity;
  discovery: BotDiscovery;
}

export class AgentRegistry {
  private readonly agents = new Map<AgentId, RegisteredAgentInfo>();

  register(id: AgentId, identity: BotIdentity, discovery: BotDiscovery): void {
    if (this.agents.has(id)) throw new Error(`Agent 已注册：${id}`);
    this.agents.set(id, { identity, discovery });
  }

  require(id: AgentId): void {
    if (!this.agents.has(id)) throw new Error(`Agent 未注册：${id}`);
  }

  requireAgent(id: AgentId): RegisteredAgentInfo {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`Agent 未注册：${id}`);
    return agent;
  }

  /** 校验 discovery 引用的 team 与 Bot 都已注册；在 host 启动期调用。 */
  assertDiscoveryReferences(teamIds: ReadonlySet<string>): void {
    for (const [id, agent] of this.agents) {
      const visibility = agent.discovery.visibleTo;
      if (visibility.kind === "team") {
        if (!teamIds.has(visibility.teamId))
          throw new Error(`Agent ${id} 的可见团队未注册：${visibility.teamId}`);
        continue;
      }
      for (const target of visibility.agentIds) {
        if (!this.agents.has(target)) throw new Error(`Agent ${id} 的发现目标未注册：${target}`);
      }
    }
  }

  /** 团队定义的入口与成员必须已经在运行时注册。 */
  assertTeamMembers(entryAgentId: AgentId, memberAgentIds: readonly AgentId[]): void {
    this.require(entryAgentId);
    for (const id of memberAgentIds) this.require(id);
  }
}
