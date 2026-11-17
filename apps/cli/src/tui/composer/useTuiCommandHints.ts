/** PromptInput 的 slash 命令候选、参数提示与会话内最近使用；不处理按键或提交。 */
import { useState } from "react";
import {
  findTuiCommand,
  suggestTuiCommands,
  tuiCommandArgumentHint,
  tuiCommandPrefix,
} from "../commands/catalog";

const RECENT_COMMAND_LIMIT = 3;

export function useTuiCommandHints({
  value,
  cursor,
  enabled,
  secret,
  hasSelection,
}: {
  value: string;
  cursor: number;
  enabled: boolean;
  secret: boolean;
  hasSelection: boolean;
}) {
  const [recentCommands, setRecentCommands] = useState<string[]>([]);
  const prefix = enabled && !secret ? tuiCommandPrefix(value) : undefined;
  const suggestions = prefix === undefined ? [] : suggestTuiCommands(prefix, recentCommands);
  const hint =
    enabled && !secret && !hasSelection && cursor === value.length
      ? tuiCommandArgumentHint(value)
      : undefined;

  const remember = (text: string): void => {
    const token = text.trim().split(/\s+/, 1)[0] ?? "";
    if (!token.startsWith("/")) return;
    const command = findTuiCommand(token.slice(1));
    if (command === undefined) return;
    setRecentCommands((current) =>
      [command.name, ...current.filter((name) => name !== command.name)].slice(
        0,
        RECENT_COMMAND_LIMIT,
      ),
    );
  };

  return { suggestions, hint, remember };
}
