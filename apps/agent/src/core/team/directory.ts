/** 团队发现规则：成员校验、可见目录与交接目标校验。 */
import type { AgentId } from "../agent/definition";
import type { TeamCatalog, TeamDefinition, TeamMemberView } from "./types";

export const MAX_HANDOFF_TASK_CHARS = 32_000;

/** Bots the viewer may discover; the viewer never appears in its own directory. */
export function visibleMembers(
  team: TeamDefinition,
  viewer: AgentId,
  catalog: TeamCatalog,
): readonly TeamMemberView[] {
  return team.memberAgentIds
    .filter((agentId) => agentId !== viewer)
    .map((agentId) => {
      const agent = catalog.require(agentId);
      return { agentId, identity: agent.identity, discovery: agent.discovery };
    })
    .filter((member) => canDiscover(member, viewer, catalog));
}

export function assertCanHandoff(
  team: TeamDefinition,
  from: AgentId,
  to: AgentId,
  catalog: TeamCatalog,
): void {
  const visible = visibleMembers(team, from, catalog).some((member) => member.agentId === to);
  if (!visible) throw new Error(`Bot 无法发现交接目标：${from} -> ${to}`);
}

export function assertHandoffTask(task: string): void {
  if (!task.trim() || task.length > MAX_HANDOFF_TASK_CHARS) throw new Error("交接内容无效或过长");
}

/** Startup validation for a static team definition. */
export function assertTeamDefinition(team: TeamDefinition, catalog: TeamCatalog): void {
  if (!team.teamId.trim()) throw new Error("团队 ID 不能为空");
  const memberIds = new Set<AgentId>();
  for (const agentId of team.memberAgentIds) {
    if (memberIds.has(agentId)) throw new Error(`团队成员重复：${agentId}`);
    memberIds.add(agentId);
  }
  if (!memberIds.has(team.entryAgentId)) {
    throw new Error(`团队入口 Bot 未注册：${team.entryAgentId}`);
  }
  for (const agentId of team.memberAgentIds) {
    const agent = catalog.require(agentId);
    const visibility = agent.discovery.visibleTo;
    if (visibility.kind === "bots") {
      for (const target of visibility.agentIds) {
        if (!memberIds.has(target)) throw new Error(`发现关系引用了团队之外的 Bot：${target}`);
      }
      continue;
    }
    if (!catalog.hasTeam(visibility.teamId))
      throw new Error(`发现关系引用了未注册的团队：${visibility.teamId}`);
  }
}

function canDiscover(member: TeamMemberView, viewer: AgentId, catalog: TeamCatalog): boolean {
  const visibility = member.discovery.visibleTo;
  if (visibility.kind === "bots") return visibility.agentIds.includes(viewer);
  return catalog.isMember(visibility.teamId, viewer);
}
