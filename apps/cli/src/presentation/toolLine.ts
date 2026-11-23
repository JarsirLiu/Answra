/** Non-TTY tool lines; summaries come from the shared presentation model. */
import { presentToolCall } from "@answra/ui/tool-presentation";
import { toolLabel } from "./toolLabels";
import { formatToolSummary } from "./toolSummary";

/** 工具调用的开始行只依赖条目里的调用信息；执行结果可能在另一条条目里。 */
export interface ToolStartLineInput {
  toolName: string;
  input?: unknown;
}

export interface ToolFinishLineInput {
  toolName: string;
  outcome: "output" | "error" | "denied";
  errorText?: string;
  durationMs?: number;
}

const MAX_ERROR_CHARS = 200;

export function toolStartLine(call: ToolStartLineInput): string {
  return formatToolSummary(
    presentToolCall({
      toolName: call.toolName,
      state: "running",
      ...(call.input === undefined ? {} : { input: call.input }),
    }),
  );
}

export function toolFinishLine(result: ToolFinishLineInput): string {
  const label = toolLabel(result.toolName);
  const status = result.outcome === "output" ? "ok" : "failed";
  const error =
    result.outcome !== "output" && result.errorText !== undefined
      ? `: ${oneLine(result.errorText, MAX_ERROR_CHARS)}`
      : "";
  const duration = result.durationMs === undefined ? "" : ` ${result.durationMs}ms`;
  return `${label} ${status}${duration}${error}`;
}

function oneLine(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}
