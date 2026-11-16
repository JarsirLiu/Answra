/** Tool summary shared by the TUI and the non-TTY presenter. */
import type { ToolPresentation } from "@answra/ui/tool-presentation";
import { actionLabel } from "./toolLabels";

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
        label: actionLabel(presentation.action),
        target: joinPath(presentation.secondary, presentation.primary),
        ...(presentation.meta ? { extra: ` ${presentation.meta}` } : {}),
      };
    case "search": {
      const parts = [`pattern: "${presentation.primary}"`];
      if (presentation.secondary) parts.push(`path: "${presentation.secondary}"`);
      if (presentation.meta) parts.push(presentation.meta);
      return { label: actionLabel("search"), target: parts.join(", ") };
    }
    case "run": {
      const extras = [
        ...(presentation.secondary ? [`in ${presentation.secondary}`] : []),
        ...(presentation.meta ? [presentation.meta] : []),
      ];
      return {
        label: actionLabel("run"),
        target: presentation.primary,
        ...(extras.length > 0 ? { extra: ` ${extras.join(" ")}` } : {}),
      };
    }
    case "write":
      return {
        label: actionLabel("write"),
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
