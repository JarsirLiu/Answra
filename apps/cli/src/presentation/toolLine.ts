/** Non-TTY tool lines; summaries come from the shared presentation model. */
import type { AgentEventEnvelope } from "@answra/shared/schema";
import {
  type CanonicalToolName,
  canonicalToolName,
  presentToolCall,
} from "@answra/ui/tool-presentation";
import { formatToolSummary } from "./toolSummary";

type ToolStarted = Extract<AgentEventEnvelope["event"], { type: "tool-execution-started" }>;
type ToolFinished = Extract<AgentEventEnvelope["event"], { type: "tool-execution-finished" }>;

const MAX_ERROR_CHARS = 200;

const TOOL_LABELS: Readonly<Record<CanonicalToolName, string>> = {
  Read: "Read",
  Grep: "Search",
  Edit: "Update",
  RunCommand: "Bash",
  WriteStdin: "Write",
};

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

export function toolLabel(toolName: string): string {
  const canonical = canonicalToolName(toolName);
  return canonical ? TOOL_LABELS[canonical] : toolName;
}

function oneLine(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}
