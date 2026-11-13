/** slash 命令候选面板：只渲染目录投影与选中态，不处理按键或提交。 */
import { Box, Text } from "ink";
import { POINTER, TUI_THEME } from "../chrome/theme";
import { type TuiCommandSpec, tuiCommandUsage } from "./catalog";

const MAX_VISIBLE_COMMANDS = 6;

export function CommandPalette({
  commands,
  selectedIndex,
}: {
  commands: readonly TuiCommandSpec[];
  selectedIndex: number;
}) {
  if (commands.length === 0) return null;
  const maxStart = Math.max(0, commands.length - MAX_VISIBLE_COMMANDS);
  const start = Math.max(
    0,
    Math.min(selectedIndex - Math.floor(MAX_VISIBLE_COMMANDS / 2), maxStart),
  );
  const visible = commands.slice(start, start + MAX_VISIBLE_COMMANDS);
  return (
    <Box flexDirection="column" marginBottom={1} paddingX={1}>
      {visible.map((command, index) => {
        const selected = start + index === selectedIndex;
        return (
          <Text key={command.name}>
            <Text color={selected ? TUI_THEME.suggestion : TUI_THEME.inactive}>
              {selected ? POINTER : " "}
            </Text>
            <Text bold={selected} color={selected ? TUI_THEME.suggestion : undefined}>
              {" "}
              {tuiCommandUsage(command)}
            </Text>
            <Text dimColor> {command.summary}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
