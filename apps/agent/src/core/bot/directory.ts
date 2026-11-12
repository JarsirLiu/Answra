/** 会话参与者 + Bot 发现 ACL 的可见目录；纯函数，不持有 store 或 run。 */
import type { AgentId } from "../agent/definition";
import type { BotCatalog } from "./catalog";
import type { BotDescriptor, BotTeamLookup } from "./contracts";

export function visibleBots<Input, Policy>({
  participants,
  viewer,
  catalog,
  teams,
}: {
  participants: readonly string[];
  viewer: string;
  catalog: BotCatalog<Input, Policy>;
  teams: BotTeamLookup;
}): readonly BotDescriptor<Input, Policy>[] {
  const seen = new Set<string>();
  const visible: BotDescriptor<Input, Policy>[] = [];
  for (const participant of participants) {
    if (participant === viewer || seen.has(participant)) continue;
    seen.add(participant);
    // participants 来自已认领的会话种子；目录缺失表示恢复数据损坏，不能静默当作不可见。
    const bot = catalog.require(participant);
    if (!canDiscover(bot, viewer, teams)) continue;
    visible.push(bot);
  }
  return visible;
}

/** 启动期校验目录内每个 Bot 的发现引用都能解析；不依赖具体领域。 */
export function assertBotDiscoveryReferences<Input, Policy>({
  catalog,
  teams,
}: {
  catalog: BotCatalog<Input, Policy>;
  teams: BotTeamLookup;
}): void {
  for (const id of catalog.ids()) {
    const bot = catalog.require(id);
    const visibility = bot.discovery.visibleTo;
    if (visibility.kind === "team") {
      if (!teams.hasTeam(visibility.teamId))
        throw new Error(`Bot 的可见团队未注册：${id} -> ${visibility.teamId}`);
      continue;
    }
    for (const target of visibility.agentIds) {
      if (!catalog.find(target)) throw new Error(`Bot 的发现目标未注册：${id} -> ${target}`);
    }
  }
}

export function assertCanHandoff<Input, Policy>({
  participants,
  from,
  to,
  catalog,
  teams,
}: {
  participants: readonly string[];
  from: AgentId;
  to: AgentId;
  catalog: BotCatalog<Input, Policy>;
  teams: BotTeamLookup;
}): void {
  const visible = visibleBots({ participants, viewer: from, catalog, teams }).some(
    (bot) => bot.id === to,
  );
  if (!visible) throw new Error(`Bot 无法发现交接目标：${from} -> ${to}`);
}

function canDiscover<Input, Policy>(
  bot: BotDescriptor<Input, Policy>,
  viewer: string,
  teams: BotTeamLookup,
): boolean {
  const visibility = bot.discovery.visibleTo;
  if (visibility.kind === "bots") return visibility.agentIds.includes(viewer as AgentId);
  return teams.isMember(visibility.teamId, viewer);
}
