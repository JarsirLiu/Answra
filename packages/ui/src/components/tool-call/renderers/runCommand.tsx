import { SquareTerminal } from "lucide-react";
import { ToolCallCard } from "../ToolCallCard";
import { ToolDetailSection, ToolErrorBlock, ToolNotice, ToolOutputBlock } from "../ToolCallDetails";
import styles from "../toolCallContent.module.css";
import type { ToolCallRendererProps } from "../toolCallPart";
import {
  asRecord,
  clipText,
  firstLine,
  formatExitCode,
  formatToolValue,
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
      actionLabel="Ran"
      icon={<SquareTerminal size={15} strokeWidth={1.7} />}
      meta={meta}
      part={part}
      primary={command ? firstLine(command) : (part.title ?? "命令")}
      secondary={workdir}
    >
      {hasDetails ? (
        <>
          {error ? <ToolErrorBlock text={error.text} /> : null}
          {command || output ? <ShellDetails command={command} output={output} /> : null}
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

function ShellDetails({ command, output }: { command?: string; output?: RunCommandOutput }) {
  const streams = output
    ? [output.stdout.trimEnd(), output.stderr.trimEnd()].filter(Boolean).join("\n")
    : "";
  const status = output
    ? output.kind === "result"
      ? output.timedOut
        ? "Command timed out"
        : output.exitCode === null || output.exitCode === undefined
          ? "Command completed"
          : `Exit code: ${output.exitCode}`
      : `${sessionStatusLabel(output.status)}${output.sessionId ? ` · ${output.sessionId}` : ""}`
    : "";
  const shellText = [command ? `$ ${command}` : "", status, streams].filter(Boolean).join("\n");
  const hasStream = Boolean(output && (output.stdout.length > 0 || output.stderr.length > 0));
  return (
    <ToolDetailSection label="Shell">
      <div className={styles.shellBlock}>
        <ToolOutputBlock text={shellText || (hasStream ? "" : "Command produced no output.")} />
        {output?.kind === "session" && output.outputTruncated ? (
          <ToolNotice>Output truncated.</ToolNotice>
        ) : null}
      </div>
    </ToolDetailSection>
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
