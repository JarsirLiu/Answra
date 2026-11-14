/** Diff tool detail: flattened hunks with bounded lines and hidden-line notice. */
import type { EditDiffDisplay } from "@answra/shared/schema";
import { Box, Text } from "ink";
import { TUI_THEME } from "../../../chrome/theme";
import { SelectableText } from "../../SelectableText";
import { TOOL_EXPANDED_DIFF_LINES, TOOL_PREVIEW_DIFF_LINES } from "../toolLayout";
import { formatHiddenLines, formatTruncated } from "./previewText";

interface DiffLine {
  readonly id: string;
  readonly kind: "hunk" | "context" | "added" | "removed";
  readonly oldLine: string;
  readonly newLine: string;
  readonly text: string;
}

export function DiffDetail({ diff, expanded }: { diff: EditDiffDisplay; expanded: boolean }) {
  const lines = flattenDiff(diff);
  const limit = expanded ? TOOL_EXPANDED_DIFF_LINES : TOOL_PREVIEW_DIFF_LINES;
  const shown = lines.slice(0, limit);
  const hidden = lines.length - shown.length;
  const notice = formatHiddenLines(hidden) ?? (diff.truncated ? formatTruncated() : undefined);

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
      {notice ? <SelectableText dimColor>{notice}</SelectableText> : null}
    </Box>
  );
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
