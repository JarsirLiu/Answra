import { FileText } from "lucide-react";
import { ToolCallCard } from "../ToolCallCard";
import { ToolDetailSection, ToolErrorBlock, ToolNotice, ToolOutputBlock } from "../ToolCallDetails";
import type { ToolCallRendererProps } from "../toolCallPart";
import {
  asRecord,
  clipText,
  formatToolValue,
  MAX_TOOL_PREVIEW_LINES,
  MAX_TOOL_VALUE_CHARS,
  numberField,
  stringField,
} from "../toolCallPresentation";

const READ_UNCHANGED_PREFIX = "Wasted call — file unchanged";
const SYSTEM_REMINDER_PATTERN = /^<system-reminder>([\s\S]*?)<\/system-reminder>\s*/;
const READ_LINE_NUMBER_PATTERN = /^(\d+)\t/;
const TOTAL_LINES_PATTERN = /(?:共|文件只有) (\d+) 行/;

interface ReadView {
  filePath?: string;
  content?: string;
  partialNotice?: string;
  numLines?: number;
  totalLines?: number;
  startLine?: number;
  truncated: boolean;
  unchanged: boolean;
}

/** Read: file name in the summary; content and line range in the shared panel. */
export function ReadToolCall({ part }: ToolCallRendererProps) {
  const input = asRecord(part.input);
  const inputPath = input ? stringField(input, "file_path") : undefined;
  const view = parseReadView(part.output, inputPath);
  const displayPath = view?.filePath ?? inputPath ?? part.title ?? "文件";
  const error = part.errorText ? clipText(part.errorText, MAX_TOOL_VALUE_CHARS) : undefined;
  const malformed =
    view === undefined && part.output !== undefined
      ? clipText(formatToolValue(part.output), MAX_TOOL_VALUE_CHARS)
      : undefined;
  const lineCount = view?.content?.split("\n").length ?? 0;
  const truncated = view?.truncated === true || lineCount > MAX_TOOL_PREVIEW_LINES;
  const preview =
    view?.content === undefined
      ? undefined
      : view.content.split("\n").slice(0, MAX_TOOL_PREVIEW_LINES).join("\n");
  const hasDetails =
    error !== undefined ||
    view?.unchanged === true ||
    view?.content !== undefined ||
    malformed !== undefined;

  return (
    <ToolCallCard
      actionLabel="读取"
      icon={<FileText size={13} />}
      meta={view?.numLines !== undefined ? `${view.numLines} 行` : undefined}
      part={part}
      primary={displayPath}
    >
      {hasDetails ? (
        <>
          {error ? <ToolErrorBlock text={error.text} /> : null}
          {view?.unchanged ? <ToolNotice>文件与上次读取一致，未重复返回内容。</ToolNotice> : null}
          {view?.content !== undefined ? (
            <ToolDetailSection label="内容">
              {preview ? (
                <ToolOutputBlock text={preview} />
              ) : view.partialNotice ? null : (
                <ToolNotice>文件内容为空。</ToolNotice>
              )}
              {view.partialNotice ? <ToolNotice>{view.partialNotice}</ToolNotice> : null}
              {!view.partialNotice && truncated ? (
                <ToolNotice>
                  仅显示前 {MAX_TOOL_PREVIEW_LINES} 行，共 {view.totalLines ?? "未知"} 行。
                </ToolNotice>
              ) : null}
              {view.startLine !== undefined &&
              view.totalLines !== undefined &&
              !truncated &&
              !view.partialNotice ? (
                <ToolNotice>
                  第 {view.startLine}–{view.startLine + (view.numLines ?? 1) - 1} 行，共{" "}
                  {view.totalLines} 行。
                </ToolNotice>
              ) : null}
            </ToolDetailSection>
          ) : null}
          {malformed ? (
            <ToolDetailSection label="结果">
              <ToolOutputBlock text={malformed.text} />
            </ToolDetailSection>
          ) : null}
        </>
      ) : undefined}
    </ToolCallCard>
  );
}

/**
 * Read reaches the renderer as the model-facing string from `formatReadOutput`:
 * leading `<system-reminder>` warnings plus cat -n content. Keep the structured
 * shape supported for older snapshots and tests.
 */
function parseReadView(value: unknown, inputPath: string | undefined): ReadView | undefined {
  if (typeof value === "string") return parseReadString(value, inputPath);
  const output = asRecord(value);
  if (!output) return undefined;
  const type = stringField(output, "type");
  if (type === "file_unchanged") {
    return {
      filePath: stringField(output, "filePath") ?? inputPath,
      truncated: false,
      unchanged: true,
    };
  }
  if (type !== "text") return undefined;
  const content = stringField(output, "content");
  if (content === undefined) return undefined;
  return {
    filePath: stringField(output, "filePath") ?? inputPath,
    content,
    partialNotice: stringField(output, "partialViewNotice"),
    numLines: numberField(output, "numLines"),
    totalLines: numberField(output, "totalLines"),
    startLine: numberField(output, "startLine"),
    truncated: output.truncated === true,
    unchanged: false,
  };
}

function parseReadString(raw: string, inputPath: string | undefined): ReadView {
  const normalized = raw.replaceAll("\r\n", "\n");
  if (normalized.startsWith(READ_UNCHANGED_PREFIX)) {
    return { filePath: inputPath, truncated: false, unchanged: true };
  }

  let content = normalized;
  let partialNotice: string | undefined;
  const reminder = content.match(SYSTEM_REMINDER_PATTERN);
  if (reminder) {
    partialNotice = reminder[1]?.trim() || undefined;
    content = content.slice(reminder[0].length);
  }
  content = content.trimEnd();
  const lines = content ? content.split("\n") : [];
  return {
    filePath: inputPath,
    content,
    partialNotice,
    numLines: lines.length > 0 ? lines.length : undefined,
    totalLines: partialNotice ? parseTotalLines(partialNotice) : undefined,
    startLine: lines[0]?.match(READ_LINE_NUMBER_PATTERN)?.[1]
      ? Number(lines[0].match(READ_LINE_NUMBER_PATTERN)?.[1])
      : undefined,
    truncated: partialNotice !== undefined,
    unchanged: false,
  };
}

function parseTotalLines(notice: string): number | undefined {
  const match = notice.match(TOTAL_LINES_PATTERN);
  return match?.[1] ? Number(match[1]) : undefined;
}
