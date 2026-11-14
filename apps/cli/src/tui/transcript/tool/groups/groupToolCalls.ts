/** Group adjacent read/search/list tool calls; labels live in groupLabel.ts. */
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
  readonly presentations: readonly ToolPresentation[];
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
  return {
    kind: "tool-group",
    id: `tool-group:${parts[0]?.id ?? "empty"}`,
    parts,
    presentations,
    running: presentations.some((presentation) => isToolRunning(presentation.state)),
    failed: presentations.some(
      (presentation) => isToolFailed(presentation.state) || presentation.errorText !== undefined,
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
