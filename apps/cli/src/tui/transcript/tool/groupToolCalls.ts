/** Group adjacent read/search/list tool calls into one Claude-style transcript row. */
import type { ConversationMessagePart } from "@answra/shared";
import {
  isToolFailed,
  isToolRunning,
  presentToolCall,
  type ToolCategory,
  type ToolPresentation,
} from "@answra/ui/tool-presentation";

export type ToolPart = Extract<ConversationMessagePart, { kind: "tool" }>;

export interface ToolGroup {
  readonly kind: "tool-group";
  readonly id: string;
  readonly parts: readonly ToolPart[];
  readonly label: string;
  readonly running: boolean;
  readonly failed: boolean;
  readonly expandable: boolean;
}

export type TranscriptPart = ConversationMessagePart | ToolGroup;

const GROUPABLE: ReadonlySet<ToolCategory> = new Set(["read", "search", "list"]);

export function groupMessageParts(parts: readonly ConversationMessagePart[]): TranscriptPart[] {
  const grouped: TranscriptPart[] = [];
  let pending: ToolPart[] = [];

  const flush = () => {
    if (pending.length === 0) return;
    if (pending.length === 1) {
      grouped.push(pending[0] as ToolPart);
    } else {
      grouped.push(toGroup(pending));
    }
    pending = [];
  };

  for (const part of parts) {
    if (part.kind === "tool" && isGroupable(part)) {
      pending.push(part);
      continue;
    }
    flush();
    grouped.push(part);
  }
  flush();
  return grouped;
}

function isGroupable(part: ToolPart): boolean {
  return GROUPABLE.has(presentationOf(part).category);
}

function toGroup(parts: readonly ToolPart[]): ToolGroup {
  const presentations = parts.map(presentationOf);
  const readTargets = new Set<string>();
  const searchTargets = new Set<string>();
  const listTargets = new Set<string>();

  for (const presentation of presentations) {
    if (presentation.category === "read") readTargets.add(presentation.primary);
    else if (presentation.category === "search") searchTargets.add(presentation.primary);
    else if (presentation.category === "list") listTargets.add(presentation.primary);
  }

  const label = [
    readTargets.size > 0 ? `Read ${readTargets.size} ${plural(readTargets.size, "file")}` : "",
    searchTargets.size > 0
      ? `searched ${searchTargets.size} ${plural(searchTargets.size, "pattern")}`
      : "",
    listTargets.size > 0
      ? `Listed ${listTargets.size} ${plural(listTargets.size, "directory", "directories")}`
      : "",
  ]
    .filter((piece) => piece.length > 0)
    .join(", ");

  return {
    kind: "tool-group",
    id: `tool-group:${parts[0]?.id ?? "empty"}`,
    parts,
    label: label || `${parts.length} tool calls`,
    running: parts.some((part) => isToolRunning(part.state)),
    failed: parts.some(
      (part) => isToolFailed(part.state) || presentationOf(part).errorText !== undefined,
    ),
    expandable: presentations.some((presentation) => presentation.expandable),
  };
}

function presentationOf(part: ToolPart): ToolPresentation {
  return presentToolCall({
    toolName: part.toolName,
    state: part.state,
    input: part.input,
    inputText: part.inputText,
    output: part.output,
    errorText: part.errorText,
    title: part.title,
  });
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}
