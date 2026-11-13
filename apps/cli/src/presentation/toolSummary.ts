/** Claude-style tool summary used by the TUI and the non-TTY presenter. */
import type { ToolAction, ToolPresentation } from "@answra/ui/tool-presentation";

const ACTION_LABELS: Readonly<Record<ToolAction, string>> = {
  read: "Read",
  search: "Search",
  edit: "Update",
  create: "Create",
  write: "Write",
  run: "Bash",
  other: "Tool",
};

export interface ToolSummary {
  readonly label: string;
  readonly target: string;
  readonly extra?: string;
}

export function summarizePresentation(presentation: ToolPresentation): ToolSummary {
  switch (presentation.action) {
    case "read":
    case "edit":
    case "create":
      return {
        label: ACTION_LABELS[presentation.action],
        target: joinPath(presentation.secondary, presentation.primary),
        ...(presentation.meta ? { extra: ` ${presentation.meta}` } : {}),
      };
    case "search": {
      const parts = [`pattern: "${presentation.primary}"`];
      if (presentation.secondary) parts.push(`path: "${presentation.secondary}"`);
      if (presentation.meta) parts.push(presentation.meta);
      return { label: ACTION_LABELS.search, target: parts.join(", ") };
    }
    case "run":
      return {
        label: ACTION_LABELS.run,
        target: presentation.primary,
        ...(presentation.secondary ? { extra: ` in ${presentation.secondary}` } : {}),
      };
    case "write":
      return {
        label: ACTION_LABELS.write,
        target: presentation.primary,
        ...(presentation.secondary ? { extra: ` · ${presentation.secondary}` } : {}),
      };
    default:
      return { label: presentation.toolName, target: presentation.primary };
  }
}

export function formatToolSummary(presentation: ToolPresentation): string {
  const summary = summarizePresentation(presentation);
  return `${summary.label}(${summary.target})${summary.extra ?? ""}`;
}

function joinPath(directory: string | undefined, name: string): string {
  if (!directory) return name;
  return `${directory.replaceAll("\\", "/")}/${name}`;
}
