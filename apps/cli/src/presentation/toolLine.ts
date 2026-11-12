/** 非 TTY 工具行的纯格式化；只读事件载荷，不写输出。 */
import type { AgentEventEnvelope } from "@answra/shared/schema";

type ToolStarted = Extract<AgentEventEnvelope["event"], { type: "tool-execution-started" }>;
type ToolFinished = Extract<AgentEventEnvelope["event"], { type: "tool-execution-finished" }>;

const MAX_DETAIL_CHARS = 80;
const MAX_ERROR_CHARS = 200;

const TOOL_LABELS: Readonly<Record<string, string>> = {
  "workspace.read": "Read",
  "workspace.grep": "Grep",
  "workspace.edit": "Edit",
  "workspace.run-command": "RunCommand",
  "workspace.write-stdin": "WriteStdin",
};

export function toolStartLine(event: ToolStarted): string {
  const label = toolLabel(event.toolName);
  const detail = summarizeToolInput(event.toolName, event.input);
  return detail === undefined ? label : `${label}(${detail})`;
}

export function toolFinishLine(event: ToolFinished): string {
  const label = toolLabel(event.toolName);
  const status = event.result.success ? "ok" : "failed";
  const error = event.result.success ? "" : `: ${oneLine(event.result.errorText, MAX_ERROR_CHARS)}`;
  return `${label} ${status} ${event.durationMs}ms${error}`;
}

export function toolLabel(toolName: string): string {
  return TOOL_LABELS[toolName] ?? toolName;
}

export function summarizeToolInput(toolName: string, input: unknown): string | undefined {
  if (typeof input === "string") return oneLine(input, MAX_DETAIL_CHARS);
  if (input === null || typeof input !== "object") return undefined;

  const record = input as Record<string, unknown>;
  if (toolName === "workspace.grep") {
    const pattern = readText(record, "pattern");
    const path = readText(record, "path");
    if (pattern !== undefined)
      return oneLine(path === undefined ? pattern : `${pattern} in ${path}`, MAX_DETAIL_CHARS);
  }
  if (toolName === "workspace.run-command") {
    const command = readCommand(record.command);
    if (command !== undefined) return oneLine(command, MAX_DETAIL_CHARS);
  }

  for (const key of ["file_path", "path", "command", "description", "url"]) {
    const value = readText(record, key);
    if (value !== undefined) return oneLine(value, MAX_DETAIL_CHARS);
  }

  try {
    const serialized = JSON.stringify(input);
    return serialized === undefined ? undefined : oneLine(serialized, MAX_DETAIL_CHARS);
  } catch {
    return undefined;
  }
}

function readText(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readCommand(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const parts = value.filter((part): part is string => typeof part === "string");
  return parts.length === value.length ? parts.join(" ") : undefined;
}

function oneLine(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}
