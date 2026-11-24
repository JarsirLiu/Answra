/** Dispatches host-agnostic tool details to Ink detail renderers. */
import {
  isToolRunning,
  type ToolDetail,
  type ToolPresentation,
} from "@answra/ui/tool-presentation";
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { DiffDetail } from "./details/DiffDetail";
import { NoticeDetail } from "./details/NoticeDetail";
import { TextDetail } from "./details/TextDetail";
import { TOOL_RESULT_GUTTER, TOOL_RESULT_GUTTER_WIDTH } from "./toolLayout";

/** 这些类别的正文只在展开时渲染：折叠态保留一行摘要，避免把大段内容挤进 transcript。 */
const COLLAPSED_HIDDEN_CATEGORIES: ReadonlySet<ToolPresentation["category"]> = new Set([
  "search",
  "skill",
]);

export function ToolDetails({
  presentation,
  expanded,
}: {
  presentation: ToolPresentation;
  expanded: boolean;
}) {
  const running = isToolRunning(presentation.state);
  const details = presentation.details.filter(
    (detail) =>
      expanded || !COLLAPSED_HIDDEN_CATEGORIES.has(presentation.category) || detail.kind !== "text",
  );
  if (details.length === 0) return null;

  return (
    <Box flexDirection="column" width="100%">
      {details.map((detail) => (
        <ToolDetailRow key={detailKey(detail)}>
          {detailNode(detail, presentation.category, expanded, running)}
        </ToolDetailRow>
      ))}
    </Box>
  );
}

function detailNode(
  detail: ToolDetail,
  category: ToolPresentation["category"],
  expanded: boolean,
  running: boolean,
): ReactNode {
  if (detail.kind === "diff") return <DiffDetail diff={detail.diff} expanded={expanded} />;
  if (detail.kind === "notice") return <NoticeDetail text={detail.text} tone={detail.tone} />;
  return <TextDetail category={category} detail={detail} expanded={expanded} running={running} />;
}

function ToolDetailRow({ children }: { children: ReactNode }) {
  return (
    <Box flexDirection="row" width="100%">
      <Box flexShrink={0} width={TOOL_RESULT_GUTTER_WIDTH}>
        <Text dimColor>{TOOL_RESULT_GUTTER}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {children}
      </Box>
    </Box>
  );
}

function detailKey(detail: ToolDetail): string {
  if (detail.kind === "text") {
    return `text:${detail.label ?? ""}:${detail.text.length}:${detail.text.slice(0, 24)}`;
  }
  if (detail.kind === "diff") {
    return `diff:${detail.diff.additions}:${detail.diff.deletions}:${detail.diff.hunks.length}`;
  }
  return `notice:${detail.tone}:${detail.text}`;
}
