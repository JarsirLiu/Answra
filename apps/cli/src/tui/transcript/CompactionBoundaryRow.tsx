/** 压缩边界：Claude 风格的边界行与可展开摘要块；摘要正文只在展开后显示。 */
import { Box } from "ink";
import { BLACK_CIRCLE, TUI_THEME } from "../chrome/theme";
import { hasCompactionMetadata, type TuiCompactionBoundary } from "./compactionBoundary";
import {
  COMPACTION_BOUNDARY_TEXT,
  COMPACTION_SUMMARY_FALLBACK_HINT,
  COMPACTION_SUMMARY_FALLBACK_TITLE,
  COMPACTION_SUMMARY_HINT,
  COMPACTION_SUMMARY_TITLE,
  compactionContextText,
  compactionSummaryCountText,
} from "./compactionText";
import { MessageResponse } from "./MessageResponse";
import { SelectableText } from "./SelectableText";

export function CompactionBoundaryRow({
  boundary,
  expanded,
}: {
  boundary: TuiCompactionBoundary;
  expanded: boolean;
}) {
  return (
    <Box flexDirection="column" width="100%">
      <Box marginY={1}>
        <SelectableText dimColor>{COMPACTION_BOUNDARY_TEXT}</SelectableText>
      </Box>
      {boundary.summary === undefined ? null : (
        <CompactionSummary boundary={boundary} expanded={expanded} />
      )}
    </Box>
  );
}

function CompactionSummary({
  boundary,
  expanded,
}: {
  boundary: TuiCompactionBoundary;
  expanded: boolean;
}) {
  const hasMetadata = hasCompactionMetadata(boundary);
  const collapsed = hasMetadata ? (
    <Box flexDirection="column">
      {boundary.summarizedMessages === undefined ? null : (
        <SelectableText dimColor>
          {compactionSummaryCountText(boundary.summarizedMessages)}
        </SelectableText>
      )}
      {boundary.instructions === undefined ? null : (
        <SelectableText dimColor>{compactionContextText(boundary.instructions)}</SelectableText>
      )}
      <SelectableText dimColor>{COMPACTION_SUMMARY_HINT}</SelectableText>
    </Box>
  ) : (
    <SelectableText dimColor>{COMPACTION_SUMMARY_FALLBACK_HINT}</SelectableText>
  );

  return (
    <Box flexDirection="row" marginTop={1} width="100%">
      <Box flexShrink={0} width={2}>
        <SelectableText color={TUI_THEME.text}>{BLACK_CIRCLE}</SelectableText>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        <SelectableText bold>
          {hasMetadata ? COMPACTION_SUMMARY_TITLE : COMPACTION_SUMMARY_FALLBACK_TITLE}
        </SelectableText>
        <MessageResponse>
          {expanded ? <SelectableText>{boundary.summary}</SelectableText> : collapsed}
        </MessageResponse>
      </Box>
    </Box>
  );
}
