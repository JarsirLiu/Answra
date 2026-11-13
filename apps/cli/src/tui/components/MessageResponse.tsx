/** Claude 风格 assistant 缩进：左侧圆点 + 两列内容，避免与工具行混排。 */
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { BLACK_CIRCLE, TUI_THEME } from "../theme";

export function MessageResponse({ children, dim }: { children: ReactNode; dim?: boolean }) {
  return (
    <Box flexDirection="row" width="100%">
      <Box flexShrink={0} width={2}>
        <Text color={dim ? TUI_THEME.inactive : TUI_THEME.text}>{BLACK_CIRCLE}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {children}
      </Box>
    </Box>
  );
}
