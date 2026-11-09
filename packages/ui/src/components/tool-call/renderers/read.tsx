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

/** Read: file name in the summary; content and line range in the details. */
export function ReadToolCall({ part }: ToolCallRendererProps) {
  const input = asRecord(part.input);
  const output = asRecord(part.output);
  const inputPath = input ? stringField(input, "file_path") : undefined;
  const outputPath = output ? stringField(output, "filePath") : undefined;
  const displayPath = outputPath ?? inputPath ?? part.title ?? "文件";
  const outputType = output ? stringField(output, "type") : undefined;
  const content = outputType === "text" && output ? stringField(output, "content") : undefined;
  const partialNotice =
    outputType === "text" && output ? stringField(output, "partialViewNotice") : undefined;
  const numLines = output ? numberField(output, "numLines") : undefined;
  const totalLines = output ? numberField(output, "totalLines") : undefined;
  const startLine = output ? numberField(output, "startLine") : undefined;
  const truncated =
    (output ? output.truncated === true : false) ||
    (content?.split("\n").length ?? 0) > MAX_TOOL_PREVIEW_LINES;
  const preview =
    content === undefined
      ? undefined
      : content.split("\n").slice(0, MAX_TOOL_PREVIEW_LINES).join("\n");
  const error = part.errorText ? clipText(part.errorText, MAX_TOOL_VALUE_CHARS) : undefined;
  const malformedOutput =
    part.output !== undefined && outputType !== "text" && outputType !== "file_unchanged"
      ? clipText(formatToolValue(part.output), MAX_TOOL_VALUE_CHARS)
      : undefined;
  const hasDetails =
    error !== undefined ||
    outputType === "file_unchanged" ||
    content !== undefined ||
    malformedOutput !== undefined;

  return (
    <ToolCallCard
      actionLabel="读取"
      icon={<FileText size={13} />}
      meta={numLines !== undefined ? `${numLines} 行` : undefined}
      part={part}
      primary={displayPath}
    >
      {hasDetails ? (
        <>
          {error ? <ToolErrorBlock text={error.text} /> : null}
          {outputType === "file_unchanged" ? (
            <ToolNotice>文件与上次读取一致，未重复返回内容。</ToolNotice>
          ) : null}
          {content !== undefined ? (
            <ToolDetailSection label="内容">
              {preview ? (
                <ToolOutputBlock text={preview} />
              ) : (
                <ToolNotice>文件内容为空。</ToolNotice>
              )}
              {partialNotice ? <ToolNotice>{partialNotice}</ToolNotice> : null}
              {!partialNotice && truncated ? (
                <ToolNotice>
                  仅显示前 {MAX_TOOL_PREVIEW_LINES} 行，共 {totalLines ?? "未知"} 行。
                </ToolNotice>
              ) : null}
              {startLine !== undefined && totalLines !== undefined && !truncated ? (
                <ToolNotice>
                  第 {startLine}–{startLine + (numLines ?? 1) - 1} 行，共 {totalLines} 行。
                </ToolNotice>
              ) : null}
            </ToolDetailSection>
          ) : null}
          {malformedOutput ? (
            <ToolDetailSection label="结果">
              <ToolOutputBlock text={malformedOutput.text} />
            </ToolDetailSection>
          ) : null}
        </>
      ) : undefined}
    </ToolCallCard>
  );
}
