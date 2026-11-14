/** Tool header row: state glyph, action label, target, and failure state. */
import type { ToolPresentation } from "@answra/ui/tool-presentation";
import { Box, Text } from "ink";
import type { ToolSummary } from "../../../presentation/toolSummary";
import { ToolLoader } from "../../chrome/ToolLoader";
import { BLACK_CIRCLE, TUI_THEME } from "../../chrome/theme";
import { SelectableText } from "../SelectableText";
import { TOOL_HEADER_WIDTH } from "./toolLayout";

const STATE_LABELS: Readonly<Record<ToolPresentation["state"], string>> = {
  "input-streaming": "preparing",
  pending: "pending",
  "awaiting-approval": "approval",
  running: "running",
  completed: "done",
  failed: "failed",
  denied: "denied",
  interrupted: "interrupted",
};

export function ToolCallHeader({
  summary,
  state,
  running,
  failed,
}: {
  summary: ToolSummary;
  state: ToolPresentation["state"];
  running: boolean;
  failed: boolean;
}) {
  return (
    <Box flexDirection="row" width="100%">
      <Box flexShrink={0} width={TOOL_HEADER_WIDTH}>
        {running ? (
          <ToolLoader />
        ) : (
          <Text color={failed ? TUI_THEME.error : TUI_THEME.text}>{BLACK_CIRCLE}</Text>
        )}
      </Box>
      <SelectableText>
        <Text bold color={failed ? TUI_THEME.error : TUI_THEME.text}>
          {summary.label}
        </Text>
        <Text>(</Text>
        <Text>{summary.target}</Text>
        <Text>)</Text>
        {summary.extra ? <Text dimColor>{summary.extra}</Text> : null}
        {failed ? <Text color={TUI_THEME.error}> · {STATE_LABELS[state]}</Text> : null}
      </SelectableText>
    </Box>
  );
}
