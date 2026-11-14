/** 压缩边界行：默认只说明上下文已压缩；Ctrl+O 展开摘要、计数与手动指令。 */
import { Box } from "ink";
import type { TuiCompactionBoundary } from "./compactionBoundary";
import { COMPACTION_BOUNDARY_TEXT } from "./compactionText";
import { SelectableText } from "./SelectableText";

export function CompactionBoundaryRow({
  boundary,
  expanded,
}: {
  boundary: TuiCompactionBoundary;
  expanded: boolean;
}) {
  const showSummary = expanded && boundary.summary !== undefined;
  return (
    <Box flexDirection="column" marginY={1}>
      <SelectableText dimColor>{COMPACTION_BOUNDARY_TEXT}</SelectableText>
      {showSummary ? (
        <Box flexDirection="column" marginTop={1}>
          <SelectableText bold>Summarized conversation</SelectableText>
          {boundary.summarizedMessages === undefined ? null : (
            <SelectableText dimColor>
              Summarized {boundary.summarizedMessages} messages up to this point
            </SelectableText>
          )}
          {boundary.instructions === undefined ? null : (
            <SelectableText dimColor>Context: “{boundary.instructions}”</SelectableText>
          )}
          <Box marginTop={1}>
            <SelectableText>{boundary.summary}</SelectableText>
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}
