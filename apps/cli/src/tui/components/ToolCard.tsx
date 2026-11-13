/** Claude 风格工具行：圆点/加载 glyph、工具名、参数摘要、结构化 diff 与结果。 */
import type { ConversationMessagePart } from "@answra/shared";
import { type EditDiffDisplay, editDiffDisplaySchema } from "@answra/shared/schema";
import { Box, Text } from "ink";
import { memo, useEffect, useState } from "react";
import { summarizeToolInput, toolLabel } from "../../presentation/toolLine";
import { BLACK_CIRCLE, SPINNER_FRAMES, TUI_THEME } from "../theme";

type ToolPart = Extract<ConversationMessagePart, { kind: "tool" }>;

const MAX_OUTPUT_LINES = 8;
const MAX_EXPANDED_OUTPUT_LINES = 200;
const MAX_DIFF_LINES = 80;
const MAX_EXPANDED_DIFF_LINES = 400;
const LOADER_MS = 120;

const STATE_LABELS: Readonly<Record<ToolPart["state"], string>> = {
  "input-streaming": "preparing",
  pending: "pending",
  "awaiting-approval": "approval",
  running: "running",
  completed: "done",
  failed: "failed",
  denied: "denied",
  interrupted: "interrupted",
};

export const ToolCard = memo(function ToolCard({
  part,
  expanded = false,
}: {
  part: ToolPart;
  expanded?: boolean;
}) {
  const label = part.title ?? toolLabel(part.toolName);
  const detail = summarizeToolInput(part.toolName, part.input);
  const diff = readEditDiff(part.output);
  const output = diff === undefined ? formatOutput(part.output, expanded) : undefined;
  const failed = part.state === "failed" || part.state === "denied";
  const running =
    part.state === "running" || part.state === "input-streaming" || part.state === "pending";
  return (
    <Box flexDirection="column" marginTop={1} width="100%">
      <Box flexDirection="row" width="100%">
        <Box flexShrink={0} width={2}>
          {running ? (
            <ToolLoader />
          ) : (
            <Text color={failed ? TUI_THEME.error : TUI_THEME.text}>{BLACK_CIRCLE}</Text>
          )}
        </Box>
        <Text bold color={failed ? TUI_THEME.error : TUI_THEME.text}>
          {label}
        </Text>
        {detail === undefined ? null : <Text dimColor>({detail})</Text>}
        {failed ? <Text color={TUI_THEME.error}> · {STATE_LABELS[part.state]}</Text> : null}
      </Box>
      {diff === undefined ? null : <DiffView diff={diff} expanded={expanded} />}
      {output === undefined ? null : <OutputView expanded={expanded} output={output} />}
      {part.errorText === undefined ? null : (
        <Box paddingLeft={2}>
          <Text color={TUI_THEME.error}>{clip(part.errorText, expanded ? 4_000 : 600)}</Text>
        </Box>
      )}
    </Box>
  );
});

function ToolLoader() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(
      () => setFrame((current) => (current + 1) % SPINNER_FRAMES.length),
      LOADER_MS,
    );
    return () => clearInterval(timer);
  }, []);
  return <Text color={TUI_THEME.claude}>{SPINNER_FRAMES[frame]}</Text>;
}

function DiffView({ diff, expanded }: { diff: EditDiffDisplay; expanded: boolean }) {
  const lines = flattenDiff(diff).slice(0, expanded ? MAX_EXPANDED_DIFF_LINES : MAX_DIFF_LINES);
  return (
    <Box flexDirection="column" paddingLeft={2} marginTop={1}>
      {lines.map((line) =>
        line.kind === "hunk" ? (
          <Text color={TUI_THEME.suggestion} key={line.id}>
            {line.text}
          </Text>
        ) : (
          <Text
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
          </Text>
        ),
      )}
      {diff.truncated ? <Text dimColor>… diff truncated</Text> : null}
    </Box>
  );
}

function OutputView({ output, expanded }: { output: string; expanded: boolean }) {
  const lines = output.split("\n").map((text, index) => ({ id: `line-${index}`, text }));
  const limit = expanded ? MAX_EXPANDED_OUTPUT_LINES : MAX_OUTPUT_LINES;
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {lines.slice(0, limit).map((line) => (
        <Text dimColor key={line.id}>
          {line.text.length === 0 ? " " : line.text}
        </Text>
      ))}
      {lines.length > limit ? <Text dimColor>… {lines.length - limit} more lines</Text> : null}
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

function readEditDiff(output: unknown): EditDiffDisplay | undefined {
  if (output === null || typeof output !== "object") return undefined;
  const diff = (output as Record<string, unknown>).diff;
  const parsed = editDiffDisplaySchema.safeParse(diff);
  return parsed.success ? parsed.data : undefined;
}

function formatOutput(output: unknown, expanded: boolean): string | undefined {
  if (output === undefined) return undefined;
  const limit = expanded ? 20_000 : 1_600;
  if (typeof output === "string") return clip(output, limit);
  try {
    return clip(JSON.stringify(output, null, 2), limit);
  } catch {
    return "工具已返回结果";
  }
}

function clip(value: string, maxChars: number): string {
  const normalized = value.trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}
