/** Shared formatting and status vocabulary for every tool call card. */
import type { AgentToolCallState } from "@answra/shared/schema";

export const TOOL_CALL_STATE_LABEL: Record<AgentToolCallState, string> = {
  "input-streaming": "准备中",
  pending: "等待执行",
  "awaiting-approval": "等待确认",
  running: "运行中",
  completed: "完成",
  failed: "失败",
  interrupted: "已中断",
  denied: "已拒绝",
};

export const MAX_TOOL_VALUE_CHARS = 8_000;
export const MAX_TOOL_STREAM_CHARS = 6_000;
export const MAX_TOOL_PREVIEW_LINES = 200;
export const TOOL_INPUT_SIZE_STEP_CHARS = 100;
export const TOOL_INPUT_SIZE_KB = 1024;

/** Rounds the streamed argument size so the meter does not change on every delta. */
export function formatToolInputStreamSize(chars: number): string {
  if (chars < TOOL_INPUT_SIZE_STEP_CHARS) return `${chars} 字符`;
  const rounded = Math.floor(chars / TOOL_INPUT_SIZE_STEP_CHARS) * TOOL_INPUT_SIZE_STEP_CHARS;
  return rounded < TOOL_INPUT_SIZE_KB
    ? `${rounded} 字符`
    : `${(rounded / TOOL_INPUT_SIZE_KB).toFixed(1)} KB`;
}

export function isToolCallRunning(state: AgentToolCallState): boolean {
  return (
    state === "input-streaming" ||
    state === "pending" ||
    state === "awaiting-approval" ||
    state === "running"
  );
}

export function isToolCallError(state: AgentToolCallState): boolean {
  return state === "failed" || state === "denied";
}

export function formatToolValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return "无法序列化工具结果";
  }
}

export function clipText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars)}\n…（已截断）`, truncated: true };
}

export function fileName(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

export function directoryName(path: string): string | undefined {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return undefined;
  return normalized.slice(0, index);
}

export function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((value) => value.trim().length > 0);
  return (line ?? text).trim();
}

export function formatExitCode(exitCode: number | null | undefined): string | undefined {
  return exitCode === null || exitCode === undefined ? undefined : `退出码 ${exitCode}`;
}

export function sessionStatusLabel(status: string): string {
  switch (status) {
    case "running":
      return "会话运行中";
    case "completed":
      return "会话完成";
    case "timed_out":
      return "会话超时";
    case "killed":
      return "会话已终止";
    default:
      return status;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

export function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

export function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}
