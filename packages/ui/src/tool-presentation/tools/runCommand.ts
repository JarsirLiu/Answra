/** RunCommand presenter: command summary, shell result line, bounded output. */
import { clipDetailText, oneLine } from "../limits";
import type { ToolDetail, ToolPresentation, ToolPresenterContext } from "../types";
import { asRecord, numberField, stringField } from "../value";

const EXIT_CODE_PATTERN = /^Exit code: (.+)$/u;
const EMPTY_OUTPUT_LINE = "Command completed successfully with no output.";
const TIMEOUT_LINE = "Command timed out before it produced a normal exit code.";

interface ShellResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly timeout: boolean;
  readonly exitCode?: number | null;
}

interface ShellSnapshot {
  readonly status: string;
  readonly sessionId?: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode?: number | null;
  readonly outputTruncated: boolean;
}

type ParsedOutput =
  | { readonly kind: "result"; readonly result: ShellResult }
  | { readonly kind: "session"; readonly snapshot: ShellSnapshot };

export function presentRunCommand(context: ToolPresenterContext): ToolPresentation {
  const input = asRecord(context.input);
  const command = input ? readCommand(input.command) : undefined;
  const workdir = input ? stringField(input, "workdir") : undefined;
  const parsed = parseRunCommandOutput(context.output);
  const legacy = parsed === undefined ? parseLegacyOutput(context.output) : undefined;
  const result = parsed?.kind === "result" ? parsed.result : legacy;
  const snapshot = parsed?.kind === "session" ? parsed.snapshot : undefined;
  const details = outputDetails(result, snapshot);
  const resultLine = resultLineFor(context.state, result, snapshot);
  const sessionId = snapshot?.sessionId;

  return {
    toolName: context.toolName,
    action: "run",
    category: "command",
    state: context.state,
    primary: command ? oneLine(command) : (context.title ?? "command"),
    ...(workdir ? { secondary: oneLine(workdir) } : {}),
    ...(sessionId ? { meta: `session ${sessionId}` } : {}),
    ...(resultLine ? { resultLine } : {}),
    ...(context.errorText ? { errorText: context.errorText } : {}),
    details,
    expandable: details.length > 0,
  };
}

function outputDetails(
  result: ShellResult | undefined,
  snapshot: ShellSnapshot | undefined,
): ToolDetail[] {
  const stdout = result?.stdout ?? snapshot?.stdout ?? "";
  const stderr = result?.stderr ?? snapshot?.stderr ?? "";
  const combined = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n");
  const clipped = clipDetailText(combined);
  const details: ToolDetail[] = [];
  if (clipped.text.length > 0) {
    details.push({
      kind: "text",
      text: clipped.text,
      wrap: false,
      truncated: clipped.truncated || snapshot?.outputTruncated === true,
      totalLines: clipped.totalLines,
    });
  }
  if (result?.timeout === true) {
    details.push({ kind: "notice", tone: "warning", text: "Command timed out." });
  }
  return details;
}

function resultLineFor(
  state: ToolPresenterContext["state"],
  result: ShellResult | undefined,
  snapshot: ShellSnapshot | undefined,
): string | undefined {
  if (snapshot) return sessionResultLine(snapshot);
  if (result) return resultResultLine(result);
  if (state === "running") return "Running…";
  return undefined;
}

function sessionResultLine(snapshot: ShellSnapshot): string {
  switch (snapshot.status) {
    case "running":
      return "Running…";
    case "timed_out":
      return "Timed out";
    case "killed":
      return "Killed";
    case "completed":
      return exitLine(snapshot.exitCode, snapshot.stdout, snapshot.stderr);
    default:
      return snapshot.status;
  }
}

function resultResultLine(result: ShellResult): string {
  if (result.timeout) return "Timed out";
  return exitLine(result.exitCode, result.stdout, result.stderr);
}

function exitLine(exitCode: number | null | undefined, stdout: string, stderr: string): string {
  if (stdout.length === 0 && stderr.length === 0) return "(No output)";
  if (exitCode === 0 || exitCode === null || exitCode === undefined) return "Done";
  return `Exit code ${exitCode}`;
}

function parseRunCommandOutput(value: unknown): ParsedOutput | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  if (record.kind === "result") {
    const result = asRecord(record.result);
    if (!result) return undefined;
    const stdout = stringField(result, "stdout");
    const stderr = stringField(result, "stderr");
    if (stdout === undefined || stderr === undefined) return undefined;
    const outcome = asRecord(result.outcome);
    return {
      kind: "result",
      result: {
        stdout,
        stderr,
        timeout: outcome ? outcome.type === "timeout" : false,
        exitCode: outcome ? (numberField(outcome, "exitCode") ?? null) : null,
      },
    };
  }
  if (record.kind === "session") {
    const snapshot = parseSnapshot(record.snapshot);
    return snapshot ? { kind: "session", snapshot } : undefined;
  }
  return undefined;
}

function parseSnapshot(value: unknown): ShellSnapshot | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const status = stringField(record, "status");
  const stdout = stringField(record, "stdout");
  const stderr = stringField(record, "stderr");
  if (status === undefined || stdout === undefined || stderr === undefined) return undefined;
  const sessionId = stringField(record, "sessionId");
  const exitCode = record.exitCode;
  return {
    status,
    ...(sessionId ? { sessionId } : {}),
    stdout,
    stderr,
    ...(typeof exitCode === "number" || exitCode === null ? { exitCode } : {}),
    outputTruncated: record.outputTruncated === true,
  };
}

function parseLegacyOutput(value: unknown): ShellResult | undefined {
  if (typeof value !== "string") return undefined;
  const lines = value.replaceAll("\r\n", "\n").split("\n");
  const timeout = lines.some((line) => line === TIMEOUT_LINE);
  const exitCode = readExitCode(lines);
  const text = lines
    .filter((line) => !isStatusLine(line))
    .join("\n")
    .trimEnd();
  if (!timeout && exitCode === undefined && text.length === 0) return undefined;
  return {
    stdout: text,
    stderr: "",
    timeout,
    ...(exitCode !== undefined ? { exitCode } : {}),
  };
}

function readExitCode(lines: readonly string[]): number | null | undefined {
  for (const line of lines) {
    const match = EXIT_CODE_PATTERN.exec(line);
    if (!match) continue;
    const value = match[1];
    if (value === undefined || value.startsWith("unavailable")) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function isStatusLine(line: string): boolean {
  return line === EMPTY_OUTPUT_LINE || line === TIMEOUT_LINE || EXIT_CODE_PATTERN.test(line);
}

function readCommand(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const parts = value.filter((part): part is string => typeof part === "string");
  return parts.length === value.length ? parts.join(" ") : undefined;
}
