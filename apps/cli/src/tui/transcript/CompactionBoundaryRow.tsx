/** Claude 风格压缩边界行：只说明上下文已压缩，不展示摘要或消息计数。 */
import { Box } from "ink";
import { COMPACTION_BOUNDARY_TEXT } from "./compactionText";
import { SelectableText } from "./SelectableText";

export function CompactionBoundaryRow() {
  return (
    <Box marginY={1}>
      <SelectableText dimColor>{COMPACTION_BOUNDARY_TEXT}</SelectableText>
    </Box>
  );
}
