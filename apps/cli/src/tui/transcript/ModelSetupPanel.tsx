/** 模型配置面板：用 Claude 式列表同时展示 Base URL、API Key 与模型 ID 的进度。 */
import { Box, Text } from "ink";
import { POINTER, TUI_THEME } from "../chrome/theme";
import { setupChecklist, type TuiSetupChecklistItem, type TuiSetupStep } from "../modelSetup";

const INDICATOR_COLUMNS = 2;

export function ModelSetupPanel({ step }: { step?: TuiSetupStep }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color={TUI_THEME.text}>
        模型配置
      </Text>
      {setupChecklist(step).map((item) => (
        <SetupRow item={item} key={item.label} />
      ))}
    </Box>
  );
}

function SetupRow({ item }: { item: TuiSetupChecklistItem }) {
  const current = item.state === "current";
  return (
    <Box flexDirection="row" paddingLeft={1}>
      <Box flexShrink={0} width={INDICATOR_COLUMNS}>
        <Text color={stateColor(item.state)}>{indicator(item.state)}</Text>
      </Box>
      <Text bold={current} color={stateColor(item.state)}>
        {item.label}
      </Text>
    </Box>
  );
}

function indicator(state: TuiSetupChecklistItem["state"]): string {
  if (state === "done") return "✓";
  if (state === "current") return POINTER;
  return "○";
}

function stateColor(state: TuiSetupChecklistItem["state"]): string {
  if (state === "done") return TUI_THEME.success;
  if (state === "current") return TUI_THEME.suggestion;
  return TUI_THEME.inactive;
}
