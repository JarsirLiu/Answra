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
    const bot = catalog.find(participant);
    if (!bot) continue;
    if (!canDiscover(bot, viewer, teams)) continue;
    visible.push(bot);
  }
  return visible;
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
