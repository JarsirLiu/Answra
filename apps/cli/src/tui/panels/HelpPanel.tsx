/** `/help` 帮助面板：展示 catalog 生成的帮助文本并支持滚动；不承载命令分派。 */
import { Box, Text, useInput, useWindowSize } from "ink";
import { useEffect, useState } from "react";
import { PanelFrame } from "../chrome/PanelFrame";
import { TUI_HELP_LINES } from "../commands/help";

const MIN_VISIBLE_LINES = 3;
const PAGE_OVERLAP_LINES = 1;

export function HelpPanel({ close }: { close(): void }) {
  const { rows } = useWindowSize();
  const visibleLines = Math.max(MIN_VISIBLE_LINES, rows - 10);
  const [start, setStart] = useState(0);
  const maxStart = Math.max(0, TUI_HELP_LINES.length - visibleLines);

  useEffect(() => {
    if (start > maxStart) setStart(maxStart);
  }, [maxStart, start]);

  useInput((_input, key) => {
    if (key.escape || key.return) {
      close();
      return;
    }
    if (key.upArrow) {
      setStart((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow) {
      setStart((current) => Math.min(maxStart, current + 1));
      return;
    }
    if (key.pageUp) {
      setStart((current) => Math.max(0, current - (visibleLines - PAGE_OVERLAP_LINES)));
      return;
    }
    if (key.pageDown) {
      setStart((current) => Math.min(maxStart, current + (visibleLines - PAGE_OVERLAP_LINES)));
    }
  });

  return (
    <PanelFrame title="帮助" footer="↑/↓ 滚动 · PgUp/PgDn 翻页 · Esc 关闭">
      <Box flexDirection="column">
        {TUI_HELP_LINES.slice(start, start + visibleLines).map((line) => (
          <Text key={line} wrap="wrap">
            {line === "" ? " " : line}
          </Text>
        ))}
      </Box>
    </PanelFrame>
  );
}
