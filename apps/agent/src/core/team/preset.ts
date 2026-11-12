/** 团队预置：只描述会话预选哪些 Bot，不持有身份、执行器或 prompt。 */
import type { AgentId } from "../agent/definition";
import type { BotCatalog } from "../bot/catalog";
import type { BotTeamLookup } from "../bot/contracts";

export interface TeamPreset {
  teamId: string;
  entryBotId: AgentId;
  memberBotIds: readonly AgentId[];
}

export interface TeamPresetCatalog {
  require(teamId: string): TeamPreset;
  find(teamId: string): TeamPreset | undefined;
  list(): readonly TeamPreset[];
  teams(): BotTeamLookup;
}

export function createTeamPresetCatalog(presets: readonly TeamPreset[]): TeamPresetCatalog {
  const byId = new Map<string, TeamPreset>();
  for (const preset of presets) {
    if (!preset.teamId.trim()) throw new Error("团队 ID 不能为空");
    if (byId.has(preset.teamId)) throw new Error(`团队已注册：${preset.teamId}`);
    byId.set(preset.teamId, preset);
  }
  const ordered = [...byId.values()];
  const lookup: BotTeamLookup = {
    hasTeam(teamId) {
      return byId.has(teamId);
    },
    isMember(teamId, agentId) {
      return byId.get(teamId)?.memberBotIds.includes(agentId as AgentId) ?? false;
    },
  };
  return {
    require(teamId) {
      const preset = byId.get(teamId);
      if (!preset) throw new Error(`团队未注册：${teamId}`);
      return preset;
    },
    find(teamId) {
      return byId.get(teamId);
    },
    list() {
      return ordered;
    },
    teams() {
      return lookup;
    },
  };
}

/** 启动期校验：入口在成员内、成员不重复、成员与发现引用都能解析。 */
export function assertTeamPreset<Input, Policy>(
  preset: TeamPreset,
  catalog: BotCatalog<Input, Policy>,
  teams: BotTeamLookup,
): void {
  if (!preset.teamId.trim()) throw new Error("团队 ID 不能为空");
  const memberIds = new Set<AgentId>();
  for (const agentId of preset.memberBotIds) {
    if (memberIds.has(agentId)) throw new Error(`团队成员重复：${agentId}`);
    memberIds.add(agentId);
  }
  if (!memberIds.has(preset.entryBotId)) {
    throw new Error(`团队入口 Bot 未注册：${preset.entryBotId}`);
  }
  for (const agentId of preset.memberBotIds) {
    const bot = catalog.require(agentId);
    const visibility = bot.discovery.visibleTo;
    if (visibility.kind === "bots") {
      for (const target of visibility.agentIds) catalog.require(target);
      continue;
    }
    if (!teams.hasTeam(visibility.teamId))
      throw new Error(`发现关系引用了未注册的团队：${visibility.teamId}`);
  }
}
