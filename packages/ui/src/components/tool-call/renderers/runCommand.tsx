import { SquareTerminal } from "lucide-react";
import { ToolCallCard } from "../ToolCallCard";
import { ToolErrorBlock, ToolNotice } from "../ToolCallDetails";
import styles from "../toolCallContent.module.css";
import type { ToolCallRendererProps } from "../toolCallPart";
import {
  asRecord,
  clipText,
  firstLine,
  formatToolValue,
  MAX_TOOL_VALUE_CHARS,
  stringField,
} from "../toolCallPresentation";

interface ShellResultOutput {
  kind: "result";
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
}

interface ShellSessionOutput {
  kind: "session";
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
}

type RunCommandOutput = ShellResultOutput | ShellSessionOutput;

interface ParsedShellOutput {
  text: string;
  truncated: boolean;
}

const SHELL_STATUS_PATTERNS = [
  /^Exit code: .+$/,
  /^Command completed successfully with no output\.$/,
  /^Command timed out before it produced a normal exit code\.$/,
];

/** RunCommand: command in the summary; one bordered Shell panel when expanded. */
export function RunCommandToolCall({ part }: ToolCallRendererProps) {
  const input = asRecord(part.input);
  const command = input ? stringField(input, "command") : undefined;
  const parsed = parseShellOutput(part.output);
  const error = part.errorText ? clipText(part.errorText, MAX_TOOL_VALUE_CHARS) : undefined;
  const malformed =
    part.output !== undefined && parsed === undefined
      ? clipText(formatToolValue(part.output), MAX_TOOL_VALUE_CHARS)
      : undefined;
  const hasDetails =
    error !== undefined || command !== undefined || parsed !== undefined || malformed !== undefined;

  return (
    <ToolCallCard
      actionLabel="Ran"
      icon={<SquareTerminal size={15} strokeWidth={1.7} />}
      part={part}
      primary={command ? firstLine(command) : (part.title ?? "命令")}
    >
      {hasDetails ? (
        <>
          {command !== undefined || parsed !== undefined || malformed !== undefined ? (
            <ShellPanel
              command={command}
              outputText={parsed?.text ?? malformed?.text}
              truncated={parsed?.truncated === true}
            />
          ) : null}
          {error ? <ToolErrorBlock text={error.text} /> : null}
        </>
      ) : undefined}
    </ToolCallCard>
  );
}

function ShellPanel({
  command,
  outputText,
  truncated,
}: {
  command?: string;
  outputText?: string;
  truncated: boolean;
}) {
  const text = [command ? `$ ${command}` : "", outputText ?? ""].filter(Boolean).join("\n");

  return (
    <div className={styles.shellPanel}>
      <div className={styles.shellLabel}>Shell</div>
      <pre className={styles.shellPre}>{text || "Command produced no output."}</pre>
      {truncated ? <ToolNotice>Output truncated.</ToolNotice> : null}
    </div>
  );
}

/**
 * Tool outputs reach the renderer as the model-facing string produced by
 * `formatModelContent`, so the agent's `Exit code` / empty-output status lines
 * must be stripped before display. Structured payloads stay supported for the
 * session snapshot shape.
 */
function parseShellOutput(value: unknown): ParsedShellOutput | undefined {
  if (typeof value === "string") {
    return { text: stripShellStatusLines(value), truncated: false };
  }
  const output = parseRunCommandOutput(value);
  if (!output) return undefined;
  return {
    text: [output.stdout.trimEnd(), output.stderr.trimEnd()].filter(Boolean).join("\n"),
    truncated: output.outputTruncated,
  };
}

function stripShellStatusLines(raw: string): string {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && isShellStatusLine(lines[0] ?? "")) lines.shift();
  while (lines.length > 0 && isShellStatusLine(lines[lines.length - 1] ?? "")) lines.pop();
  return lines
    .join("\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .trimEnd();
}

function isShellStatusLine(line: string): boolean {
  return SHELL_STATUS_PATTERNS.some((pattern) => pattern.test(line));
}

function parseRunCommandOutput(value: unknown): RunCommandOutput | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  if (record.kind === "result") {
    const result = asRecord(record.result);
    const stdout = result ? stringField(result, "stdout") : undefined;
    const stderr = result ? stringField(result, "stderr") : undefined;
    if (stdout === undefined || stderr === undefined) return undefined;
    return { kind: "result", stdout, stderr, outputTruncated: false };
  }
  if (record.kind === "session") {
    const snapshot = asRecord(record.snapshot);
    const stdout = snapshot ? stringField(snapshot, "stdout") : undefined;
    const stderr = snapshot ? stringField(snapshot, "stderr") : undefined;
    if (!snapshot || stdout === undefined || stderr === undefined) return undefined;
    return {
      kind: "session",
      stdout,
      stderr,
      outputTruncated: snapshot.outputTruncated === true,
    };
  }
  return undefined;
}
