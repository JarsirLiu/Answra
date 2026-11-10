import { CornerDownLeft } from "lucide-react";
import { ToolCallCard } from "../ToolCallCard";
import { ToolDetailSection, ToolErrorBlock, ToolNotice, ToolOutputBlock } from "../ToolCallDetails";
import type { ToolCallRendererProps } from "../toolCallPart";
import {
  asRecord,
  clipText,
  firstLine,
  formatExitCode,
  formatToolValue,
  MAX_TOOL_STREAM_CHARS,
  MAX_TOOL_VALUE_CHARS,
  sessionStatusLabel,
  stringField,
} from "../toolCallPresentation";

interface ShellSessionSnapshot {
  status: string;
  sessionId?: string;
  stdout: string;
  stderr: string;
  exitCode: number | null | undefined;
  outputTruncated: boolean;
}

/** WriteStdin: session id in the summary; incremental output and status in the details. */
export function WriteStdinToolCall({ part }: ToolCallRendererProps) {
  const input = asRecord(part.input);
  const inputSessionId = input ? stringField(input, "sessionId") : undefined;
  const chars = input ? stringField(input, "chars") : undefined;
  const output = parseSnapshot(part.output);
  const error = part.errorText ? clipText(part.errorText, MAX_TOOL_VALUE_CHARS) : undefined;
  const malformed =
    part.output !== undefined && output === undefined
      ? clipText(formatToolValue(part.output), MAX_TOOL_VALUE_CHARS)
      : undefined;
  const hasDetails =
    error !== undefined || chars !== undefined || output !== undefined || malformed !== undefined;

  return (
    <ToolCallCard
      actionLabel="写入"
      icon={<CornerDownLeft size={13} />}
      meta={output ? sessionStatusLabel(output.status) : undefined}
      part={part}
      primary={output?.sessionId ?? inputSessionId ?? part.title ?? "会话"}
      secondary={chars ? firstLine(chars) : undefined}
    >
      {hasDetails ? (
        <>
          {error ? <ToolErrorBlock text={error.text} /> : null}
          {chars ? (
            <ToolDetailSection label="写入">
              <ToolOutputBlock text={chars} />
            </ToolDetailSection>
          ) : null}
          {output ? <SnapshotDetails output={output} /> : null}
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

function SnapshotDetails({ output }: { output: ShellSessionSnapshot }) {
  const hasStream = output.stdout.length > 0 || output.stderr.length > 0;
  return (
    <>
      {output.stdout ? (
        <ToolDetailSection label="stdout">
          <ToolOutputBlock text={clipText(output.stdout, MAX_TOOL_STREAM_CHARS).text} />
        </ToolDetailSection>
      ) : null}
      {output.stderr ? (
        <ToolDetailSection label="stderr">
          <ToolOutputBlock
            text={clipText(output.stderr, MAX_TOOL_STREAM_CHARS).text}
            tone="error"
          />
        </ToolDetailSection>
      ) : null}
      {!hasStream ? <ToolNotice>会话没有新增输出。</ToolNotice> : null}
      <ToolNotice>
        {sessionStatusLabel(output.status)}
        {output.sessionId ? ` · ${output.sessionId}` : ""}
        {formatExitCode(output.exitCode) ? ` · ${formatExitCode(output.exitCode)}` : ""}
        {output.outputTruncated ? " · 输出已截断" : ""}
      </ToolNotice>
    </>
  );
}

function parseSnapshot(value: unknown): ShellSessionSnapshot | undefined {
  const record = asRecord(parseJsonRecord(value));
  if (!record) return undefined;
  const status = stringField(record, "status");
  const stdout = stringField(record, "stdout");
  const stderr = stringField(record, "stderr");
  if (status === undefined || stdout === undefined || stderr === undefined) return undefined;
  return {
    status,
    sessionId: stringField(record, "sessionId"),
    stdout,
    stderr,
    exitCode: exitCodeOf(record),
    outputTruncated: record.outputTruncated === true,
  };
}

function exitCodeOf(record: Record<string, unknown>): number | null | undefined {
  const value = record.exitCode;
  if (value === null || value === undefined || typeof value === "number") return value;
  return undefined;
}

/** WriteStdin's model-facing output is a JSON snapshot string. */
function parseJsonRecord(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}
