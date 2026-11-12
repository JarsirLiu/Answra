/** Agent 的启动期执行注册表；只记录可执行 Agent ID，身份与发现归 BotCatalog。 */
import type { AgentId } from "./definition";

export class AgentRegistry {
  private readonly agentIds = new Set<AgentId>();

  register(id: AgentId): void {
    if (this.agentIds.has(id)) throw new Error(`Agent 已注册：${id}`);
    this.agentIds.add(id);
  }

  require(id: AgentId): void {
    if (!this.agentIds.has(id)) throw new Error(`Agent 未注册：${id}`);
  }

  /** 团队定义的入口与成员必须已经在运行时注册。 */
  assertTeamMembers(entryAgentId: AgentId, memberAgentIds: readonly AgentId[]): void {
    this.require(entryAgentId);
    for (const id of memberAgentIds) this.require(id);
  }
}
