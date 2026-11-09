import { Terminal } from "lucide-react";
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

interface ShellResultOutput {
  kind: "result";
  stdout: string;
  stderr: string;
  timedOut: boolean;
  exitCode: number | null | undefined;
}

interface ShellSessionOutput {
  kind: "session";
  status: string;
  sessionId?: string;
  stdout: string;
  stderr: string;
  exitCode: number | null | undefined;
  outputTruncated: boolean;
}

type RunCommandOutput = ShellResultOutput | ShellSessionOutput;

/** RunCommand: command in the summary; stdout/stderr/exit status in the details. */
export function RunCommandToolCall({ part }: ToolCallRendererProps) {
  const input = asRecord(part.input);
  const command = input ? stringField(input, "command") : undefined;
  const workdir = input ? stringField(input, "workdir") : undefined;
  const output = parseRunCommandOutput(part.output);
  const error = part.errorText ? clipText(part.errorText, MAX_TOOL_VALUE_CHARS) : undefined;
  const malformed =
    part.output !== undefined && output === undefined
      ? clipText(formatToolValue(part.output), MAX_TOOL_VALUE_CHARS)
      : undefined;
  const meta = output
    ? output.kind === "result"
      ? output.timedOut
        ? "超时"
        : formatExitCode(output.exitCode)
      : sessionStatusLabel(output.status)
    : undefined;
  const hasDetails =
    error !== undefined || command !== undefined || output !== undefined || malformed !== undefined;

  return (
    <ToolCallCard
      actionLabel="运行"
      icon={<Terminal size={13} />}
      meta={meta}
      part={part}
      primary={command ? firstLine(command) : (part.title ?? "命令")}
      secondary={workdir}
    >
      {hasDetails ? (
        <>
          {error ? <ToolErrorBlock text={error.text} /> : null}
          {command ? (
            <ToolDetailSection label="命令">
              <ToolOutputBlock text={command} />
            </ToolDetailSection>
          ) : null}
          {output ? <ShellDetails output={output} /> : null}
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

function ShellDetails({ output }: { output: RunCommandOutput }) {
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
      {!hasStream ? <ToolNotice>命令没有输出。</ToolNotice> : null}
      {output.kind === "result" ? (
        <ToolNotice>
          {output.timedOut
            ? "命令在超时前未正常退出。"
            : (formatExitCode(output.exitCode) ?? "已完成")}
        </ToolNotice>
      ) : (
        <ToolNotice>
          {sessionStatusLabel(output.status)}
          {output.sessionId ? ` · ${output.sessionId}` : ""}
          {output.outputTruncated ? " · 输出已截断" : ""}
        </ToolNotice>
      )}
    </>
  );
}

function parseRunCommandOutput(value: unknown): RunCommandOutput | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  if (record.kind === "result") {
    const result = asRecord(record.result);
    const outcome = result ? asRecord(result.outcome) : undefined;
    const stdout = result ? stringField(result, "stdout") : undefined;
    const stderr = result ? stringField(result, "stderr") : undefined;
    const outcomeType = outcome ? stringField(outcome, "type") : undefined;
    if (stdout === undefined || stderr === undefined) return undefined;
    if (outcomeType !== "exit" && outcomeType !== "timeout") return undefined;
    return {
      kind: "result",
      stdout,
      stderr,
      timedOut: outcomeType === "timeout",
      exitCode: outcome ? exitCodeOf(outcome) : undefined,
    };
  }
  if (record.kind === "session") {
    const snapshot = asRecord(record.snapshot);
    const status = snapshot ? stringField(snapshot, "status") : undefined;
    const stdout = snapshot ? stringField(snapshot, "stdout") : undefined;
    const stderr = snapshot ? stringField(snapshot, "stderr") : undefined;
    if (!snapshot || status === undefined || stdout === undefined || stderr === undefined)
      return undefined;
    return {
      kind: "session",
      status,
      sessionId: stringField(snapshot, "sessionId"),
      stdout,
      stderr,
      exitCode: exitCodeOf(snapshot),
      outputTruncated: snapshot.outputTruncated === true,
    };
  }
  return undefined;
}

function exitCodeOf(record: Record<string, unknown>): number | null | undefined {
  const value = record.exitCode;
  if (value === null || value === undefined || typeof value === "number") return value;
  return undefined;
}
