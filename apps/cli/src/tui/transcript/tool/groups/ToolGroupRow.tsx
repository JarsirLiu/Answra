/** Folded read/search/list row with a tense-aware label and current target. */
import { Box, Text } from "ink";
import { ToolLoader } from "../../../chrome/ToolLoader";
import { BLACK_CIRCLE, TUI_THEME } from "../../../chrome/theme";
import { SelectableText } from "../../SelectableText";
import { ToolCall } from "../ToolCall";
import { TOOL_EXPAND_HINT, TOOL_HEADER_WIDTH } from "../toolLayout";
import { groupLabel } from "./groupLabel";
import type { ToolGroup } from "./groupToolCalls";

export function ToolGroupRow({ group, expanded }: { group: ToolGroup; expanded: boolean }) {
  const { label, currentTarget } = groupLabel(group.presentations, group.running);

  return (
    <Box flexDirection="column" marginTop={1} width="100%">
      <Box flexDirection="row" width="100%">
        <Box flexShrink={0} width={TOOL_HEADER_WIDTH}>
          {group.running ? (
            <ToolLoader />
          ) : (
            <Text color={group.failed ? TUI_THEME.error : TUI_THEME.text}>{BLACK_CIRCLE}</Text>
          )}
        </Box>
        <SelectableText>
          <Text bold color={group.failed ? TUI_THEME.error : TUI_THEME.text}>
            {label}
          </Text>
          {currentTarget ? <Text dimColor> · {currentTarget}</Text> : null}
          {!expanded && group.expandable ? <Text dimColor>{TOOL_EXPAND_HINT}</Text> : null}
        </SelectableText>
      </Box>
      {expanded
        ? group.parts.map((part) => <ToolCall expanded key={part.id} nested part={part} />)
        : null}
    </Box>
  );
}
