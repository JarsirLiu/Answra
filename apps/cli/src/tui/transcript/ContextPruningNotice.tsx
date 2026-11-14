import type { ContextPruningStatus } from "@answra/shared";
import { contextPruningLabel } from "@answra/ui/conversation-view";
import { Box, Text } from "ink";
import { TUI_THEME } from "../chrome/theme";

export function ContextPruningNotice({ status }: { status: ContextPruningStatus }) {
  return (
    <Box paddingX={1}>
      <Text color={TUI_THEME.compaction}>✻ {contextPruningLabel(status)}</Text>
    </Box>
  );
}
