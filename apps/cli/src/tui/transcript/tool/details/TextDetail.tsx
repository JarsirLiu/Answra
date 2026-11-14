/** Text tool detail: bounded head or running tail with a hidden-line notice. */
import type { ToolCategory, ToolDetail } from "@answra/ui/tool-presentation";
import { Box } from "ink";
import { SelectableText } from "../../SelectableText";
import { textDetailLimit } from "../toolLayout";
import { formatHiddenLines, formatTruncated, headPreview, tailPreview } from "./previewText";

type TextToolDetail = Extract<ToolDetail, { kind: "text" }>;

export function TextDetail({
  detail,
  category,
  expanded,
  running,
}: {
  detail: TextToolDetail;
  category: ToolCategory;
  expanded: boolean;
  running: boolean;
}) {
  const runningTail = running && category === "command";
  const limit = textDetailLimit(expanded, runningTail);
  const preview = runningTail ? tailPreview(detail.text, limit) : headPreview(detail.text, limit);
  const hidden =
    formatHiddenLines(preview.hidden) ??
    (detail.truncated || preview.truncated ? formatTruncated() : undefined);

  return (
    <Box flexDirection="column">
      {detail.label ? <SelectableText dimColor>{detail.label}</SelectableText> : null}
      <SelectableText dimColor>{preview.text}</SelectableText>
      {hidden ? <SelectableText dimColor>{hidden}</SelectableText> : null}
    </Box>
  );
}
