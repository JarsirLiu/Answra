/** CLI action labels shared by the TUI and the non-TTY presenter. */
import {
  type CanonicalToolName,
  canonicalToolName,
  type ToolAction,
} from "@answra/ui/tool-presentation";

const ACTION_LABELS: Readonly<Record<ToolAction, string>> = {
  read: "Read",
  search: "Search",
  edit: "Update",
  create: "Create",
  write: "Write",
  run: "Bash",
  other: "Tool",
};

const CANONICAL_LABELS: Readonly<Record<CanonicalToolName, string>> = {
  Read: "Read",
  Grep: "Search",
  Edit: "Update",
  RunCommand: "Bash",
  Skill: "Skill",
};

export function actionLabel(action: ToolAction): string {
  return ACTION_LABELS[action];
}

export function toolLabel(toolName: string): string {
  const canonical = canonicalToolName(toolName);
  return canonical ? CANONICAL_LABELS[canonical] : toolName;
}
