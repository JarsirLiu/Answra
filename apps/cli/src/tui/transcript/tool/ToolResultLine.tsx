/** Tool result line under the `⎿` gutter, including error and expand hint. */
import { Box, Text } from "ink";
import { TUI_THEME } from "../../chrome/theme";
import { SelectableText } from "../SelectableText";
import { TOOL_RESULT_GUTTER, TOOL_RESULT_GUTTER_WIDTH } from "./toolLayout";

export function ToolResultLine({
  error,
  resultLine,
  errorText,
  hint,
}: {
  error: boolean;
  resultLine?: string;
  errorText?: string;
  hint?: string;
}) {
  return (
    <Box flexDirection="row" width="100%">
      <Box flexShrink={0} width={TOOL_RESULT_GUTTER_WIDTH}>
        <Text color={error ? TUI_THEME.error : TUI_THEME.inactive}>{TOOL_RESULT_GUTTER}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        <SelectableText color={error ? TUI_THEME.error : undefined} dimColor={!error}>
          {errorText ?? resultLine ?? ""}
          {hint ? <Text dimColor>{hint}</Text> : null}
        </SelectableText>
      </Box>
    </Box>
  );
}
