/** Canonical tool identity for presentation; accepts model names and legacy ids. */

export type CanonicalToolName =
  | "Read"
  | "Grep"
  | "Edit"
  | "RunCommand"
  | "Skill"
  | "WebSearch"
  | "WebFetch";

const ALIASES: Readonly<Record<string, CanonicalToolName>> = {
  read: "Read",
  "workspace.read": "Read",
  grep: "Grep",
  search: "Grep",
  "workspace.grep": "Grep",
  edit: "Edit",
  update: "Edit",
  "workspace.edit": "Edit",
  runcommand: "RunCommand",
  "run-command": "RunCommand",
  run_command: "RunCommand",
  bash: "RunCommand",
  "workspace.run-command": "RunCommand",
  skill: "Skill",
  "skill.load": "Skill",
  websearch: "WebSearch",
  "web.search": "WebSearch",
  web_search: "WebSearch",
  webfetch: "WebFetch",
  "web.fetch": "WebFetch",
  web_fetch: "WebFetch",
};

export function canonicalToolName(toolName: string): CanonicalToolName | undefined {
  return ALIASES[toolName.trim().toLowerCase()];
}
