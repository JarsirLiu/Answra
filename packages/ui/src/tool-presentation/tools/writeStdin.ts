/** WriteStdin presenter: session summary plus incremental shell output. */
import { clipDetailText, oneLine } from "../limits";
import type { ToolDetail, ToolPresentation, ToolPresenterContext } from "../types";
import { asRecord, stringField } from "../value";

interface ShellSessionSnapshot {
  readonly status: string;
  readonly sessionId?: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode?: number | null;
  readonly outputTruncated: boolean;
}

export function presentWriteStdin(context: ToolPresenterContext): ToolPresentation {
  const input = asRecord(context.input);
  const inputSessionId = input ? stringField(input, "sessionId") : undefined;
  const chars = input ? stringField(input, "chars") : undefined;
  const snapshot = parseSnapshot(context.output);
  const details = outputDetails(snapshot);
  const primary = snapshot?.sessionId ?? inputSessionId ?? context.title ?? "session";
  const resultLine = snapshot ? sessionResultLine(snapshot) : undefined;

  return {
    toolName: context.toolName,
    action: "write",
    category: "write",
    state: context.state,
    primary,
    ...(chars ? { secondary: oneLine(chars) } : {}),
    ...(resultLine ? { resultLine } : {}),
    ...(context.errorText ? { errorText: context.errorText } : {}),
    details,
    expandable: details.length > 0,
  };
}

function outputDetails(snapshot: ShellSessionSnapshot | undefined): ToolDetail[] {
  if (!snapshot) return [];
  const combined = [snapshot.stdout.trimEnd(), snapshot.stderr.trimEnd()]
    .filter(Boolean)
    .join("\n");
  const clipped = clipDetailText(combined);
  if (clipped.text.length === 0) {
    return [{ kind: "notice", tone: "muted", text: "No new output." }];
  }
  return [
    {
      kind: "text",
      text: clipped.text,
      wrap: false,
      truncated: clipped.truncated || snapshot.outputTruncated,
      totalLines: clipped.totalLines,
    },
  ];
}

function sessionResultLine(snapshot: ShellSessionSnapshot): string {
  switch (snapshot.status) {
    case "running":
      return "Running…";
    case "timed_out":
      return "Timed out";
    case "killed":
      return "Killed";
    case "completed":
      return snapshot.exitCode !== undefined &&
        snapshot.exitCode !== null &&
        snapshot.exitCode !== 0
        ? `Exit code ${snapshot.exitCode}`
        : "Completed";
    default:
      return snapshot.status;
  }
}

function parseSnapshot(value: unknown): ShellSessionSnapshot | undefined {
  const record = asRecord(parseJsonRecord(value));
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

function parseJsonRecord(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}
