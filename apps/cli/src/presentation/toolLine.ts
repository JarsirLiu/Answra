/** Non-TTY tool lines; summaries come from the shared presentation model. */
import type { AgentStreamEvent } from "@answra/shared/schema";
import { presentToolCall } from "@answra/ui/tool-presentation";
import { toolLabel } from "./toolLabels";
import { formatToolSummary } from "./toolSummary";

type ToolStarted = Extract<AgentStreamEvent, { type: "tool-execution-started" }>;
type ToolFinished = Extract<AgentStreamEvent, { type: "tool-execution-finished" }>;

const MAX_ERROR_CHARS = 200;

export function toolStartLine(event: ToolStarted): string {
  return formatToolSummary(
    presentToolCall({ toolName: event.toolName, state: "running", input: event.input }),
  );
}

export function toolFinishLine(event: ToolFinished): string {
  const label = toolLabel(event.toolName);
  const status = event.result.success ? "ok" : "failed";
  const error = event.result.success ? "" : `: ${oneLine(event.result.errorText, MAX_ERROR_CHARS)}`;
  return `${label} ${status} ${event.durationMs}ms${error}`;
}

function oneLine(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}
