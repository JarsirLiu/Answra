/** Host-agnostic tool call presentation contract; no React, DOM, or Ink. */
import type { AgentToolCallState, EditDiffDisplay } from "@answra/shared/schema";
import type { CanonicalToolName } from "./registry";

/** Semantic action; hosts own the visible label (Read / Search / Update / Bash…). */
export type ToolAction = "read" | "search" | "edit" | "create" | "write" | "run" | "other";

/** Grouping category used by transcript folding. */
export type ToolCategory = "read" | "search" | "list" | "command" | "write" | "skill" | "other";

export type ToolDetail =
  | {
      readonly kind: "text";
      readonly label?: string;
      readonly text: string;
      readonly wrap: boolean;
      readonly truncated: boolean;
      readonly totalLines?: number;
    }
  | { readonly kind: "diff"; readonly diff: EditDiffDisplay }
  | {
      readonly kind: "notice";
      readonly tone: "muted" | "warning" | "error";
      readonly text: string;
    };

export interface ToolPresentation {
  readonly toolName: string;
  readonly action: ToolAction;
  readonly category: ToolCategory;
  readonly state: AgentToolCallState;
  /** Primary target: file name, pattern, command, session id, or fallback title. */
  readonly primary: string;
  /** Secondary target: directory, glob, workdir, stdin preview. */
  readonly secondary?: string;
  /** Summary statistics such as `+2 -1`, `3 matches`, or `2 files`. */
  readonly meta?: string;
  /** One-line tool result, rendered after the `⎿` gutter. */
  readonly resultLine?: string;
  readonly errorText?: string;
  readonly details: readonly ToolDetail[];
  readonly expandable: boolean;
}

export interface ToolPresentationInput {
  readonly toolName: string;
  readonly state: AgentToolCallState;
  readonly input?: unknown;
  readonly inputText?: string;
  readonly output?: unknown;
  readonly errorText?: string;
  readonly title?: string;
}

export interface ToolPresenterContext extends ToolPresentationInput {
  readonly canonicalName: CanonicalToolName;
}

export function isToolRunning(state: AgentToolCallState): boolean {
  return (
    state === "input-streaming" ||
    state === "pending" ||
    state === "awaiting-approval" ||
    state === "running"
  );
}

export function isToolFailed(state: AgentToolCallState): boolean {
  return state === "failed" || state === "denied" || state === "interrupted";
}
