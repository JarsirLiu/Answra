/** Tool detail projection under Claude's `⎿` gutter: text, diff, and notices. */
import type { EditDiffDisplay } from "@answra/shared/schema";
import {
  isToolRunning,
  type ToolCategory,
  type ToolDetail,
  type ToolPresentation,
} from "@answra/ui/tool-presentation";
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { TUI_THEME } from "../../chrome/theme";
import { SelectableText } from "../SelectableText";

const PREVIEW_TEXT_LINES = 5;
const PREVIEW_WRITE_LINES = 3;
const PREVIEW_DIFF_LINES = 12;
const EXPANDED_TEXT_LINES = 200;
const EXPANDED_DIFF_LINES = 400;

export function ToolCallDetails({
  presentation,
  expanded,
}: {
  presentation: ToolPresentation;
  expanded: boolean;
}) {
  const running = isToolRunning(presentation.state);
  return (
    <Box flexDirection="column" width="100%">
      {presentation.details.map((detail) => (
        <DetailRow
          category={presentation.category}
          detail={detail}
          expanded={expanded}
          key={detailKey(detail)}
          running={running}
        />
      ))}
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

function DetailRow({
  detail,
  expanded,
  category,
  running,
}: {
  detail: ToolDetail;
  expanded: boolean;
  category: ToolCategory;
  running: boolean;
}) {
  if (detail.kind === "diff") {
    return (
      <ToolResultRow>
        <DiffView diff={detail.diff} limit={expanded ? EXPANDED_DIFF_LINES : PREVIEW_DIFF_LINES} />
      </ToolResultRow>
    );
  }
  if (detail.kind === "notice") {
    return (
      <ToolResultRow>
        <Text color={noticeColor(detail.tone)} dimColor={detail.tone === "muted"}>
          {detail.text}
        </Text>
      </ToolResultRow>
    );
  }
  if (!expanded && category === "search") return null;
  const limit = expanded
    ? EXPANDED_TEXT_LINES
    : category === "write"
      ? PREVIEW_WRITE_LINES
      : PREVIEW_TEXT_LINES;
  const preview =
    category === "command" && running
      ? tailLines(detail.text, limit)
      : headLines(detail.text, limit);
  return (
    <ToolResultRow>
      <SelectableText dimColor>
        {detail.label ? `${detail.label}\n${preview.text}` : preview.text}
      </SelectableText>
    </ToolResultRow>
  );
}

function ToolResultRow({ children }: { children: ReactNode }) {
  return (
    <Box flexDirection="row" width="100%">
      <Box flexShrink={0} width={5}>
        <Text dimColor>{"  ⎿  "}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {children}
      </Box>
    </Box>
  );
}

function headLines(text: string, limit: number): { text: string; hidden: number } {
  const lines = text.split("\n");
  if (lines.length <= limit) return { text, hidden: 0 };
  return { text: lines.slice(0, limit).join("\n"), hidden: lines.length - limit };
}

function tailLines(text: string, limit: number): { text: string; hidden: number } {
  const lines = text.split("\n");
  if (lines.length <= limit) return { text, hidden: 0 };
  return { text: lines.slice(-limit).join("\n"), hidden: lines.length - limit };
}

function noticeColor(tone: "muted" | "warning" | "error"): string | undefined {
  if (tone === "error") return TUI_THEME.error;
  if (tone === "warning") return TUI_THEME.warning;
  return undefined;
}

function DiffView({ diff, limit }: { diff: EditDiffDisplay; limit: number }) {
  const lines = flattenDiff(diff);
  const shown = lines.slice(0, limit);
  return (
    <Box flexDirection="column">
      {shown.map((line) =>
        line.kind === "hunk" ? (
          <SelectableText color={TUI_THEME.suggestion} key={line.id}>
            {line.text}
          </SelectableText>
        ) : (
          <SelectableText
            backgroundColor={
              line.kind === "added"
                ? TUI_THEME.diffAdded
                : line.kind === "removed"
                  ? TUI_THEME.diffRemoved
                  : undefined
            }
            key={line.id}
          >
            <Text dimColor>{line.oldLine.padStart(4)} </Text>
            <Text dimColor>{line.newLine.padStart(4)} </Text>
            <Text
              color={
                line.kind === "added"
                  ? TUI_THEME.success
                  : line.kind === "removed"
                    ? TUI_THEME.error
                    : undefined
              }
            >
              {line.text.length === 0 ? " " : line.text}
            </Text>
          </SelectableText>
        ),
      )}
      {diff.truncated ? <SelectableText dimColor>… diff truncated</SelectableText> : null}
    </Box>
  );
}

interface DiffLine {
  id: string;
  kind: "hunk" | "context" | "added" | "removed";
  oldLine: string;
  newLine: string;
  text: string;
}

function flattenDiff(diff: EditDiffDisplay): DiffLine[] {
  const result: DiffLine[] = [];
  let nextId = 0;
  for (const hunk of diff.hunks) {
    result.push({
      id: `diff-${nextId++}`,
      kind: "hunk",
      oldLine: "",
      newLine: "",
      text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    });
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.kind === "added") {
        result.push({
          id: `diff-${nextId++}`,
          kind: "added",
          oldLine: "",
          newLine: String(newLine),
          text: `+${line.text}`,
        });
        newLine += 1;
      } else if (line.kind === "removed") {
        result.push({
          id: `diff-${nextId++}`,
          kind: "removed",
          oldLine: String(oldLine),
          newLine: "",
          text: `-${line.text}`,
        });
        oldLine += 1;
      } else {
        result.push({
          id: `diff-${nextId++}`,
          kind: "context",
          oldLine: String(oldLine),
          newLine: String(newLine),
          text: ` ${line.text}`,
        });
        oldLine += 1;
        newLine += 1;
      }
    }
  }
  return result;
}
