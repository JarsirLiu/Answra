/** Claude 式 Pane：顶部横线、标题、dim 说明与 footer；只负责面板外观，不处理按键。 */
import { Box, Text, useWindowSize } from "ink";
import type { ReactNode } from "react";
import { TUI_THEME } from "./theme";

export function PanelFrame({
  title,
  description,
  footer,
  children,
}: {
  title: string;
  description?: string;
  footer?: string;
  children: ReactNode;
}) {
  const { columns } = useWindowSize();
  return (
    <Box flexDirection="column" paddingTop={1} width="100%">
      <Text color={TUI_THEME.suggestion}>{"─".repeat(Math.max(1, columns))}</Text>
      <Box flexDirection="column" paddingX={2}>
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={TUI_THEME.suggestion}>
            {title}
          </Text>
          {description === undefined ? null : <Text dimColor>{description}</Text>}
        </Box>
        {children}
        {footer === undefined ? null : (
          <Box marginTop={1}>
            <Text dimColor italic>
              {footer}
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
