/** 启动期构建的不可变 Bot 目录；运行期不增删。 */
import type { AgentId } from "../agent/definition";
import type { BotDescriptor, BotSummary } from "./contracts";
import { summarizeBot } from "./contracts";

export interface BotCatalog<Input, Policy> {
  require(id: string): BotDescriptor<Input, Policy>;
  find(id: string): BotDescriptor<Input, Policy> | undefined;
  list(): readonly BotSummary[];
  ids(): readonly AgentId[];
}

export function createBotCatalog<Input, Policy>(
  bots: readonly BotDescriptor<Input, Policy>[],
): BotCatalog<Input, Policy> {
  const byId = new Map<string, BotDescriptor<Input, Policy>>();
  for (const bot of bots) {
    if (!bot.id.trim()) throw new Error("Bot ID 不能为空");
    if (byId.has(bot.id)) throw new Error(`Bot 已注册：${bot.id}`);
    if (!bot.identity.name.trim() || !bot.identity.role.trim())
      throw new Error(`Bot 身份不完整：${bot.id}`);
    byId.set(bot.id, bot);
  }
  const ordered = [...byId.values()];
  return {
    require(id) {
      const bot = byId.get(id);
      if (!bot) throw new Error(`Bot 未注册：${id}`);
      return bot;
    },
    find(id) {
      return byId.get(id);
    },
    list() {
      return ordered.map(summarizeBot);
    },
    ids() {
      return ordered.map((bot) => bot.id);
    },
  };
}
