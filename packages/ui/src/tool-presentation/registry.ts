/** Canonical tool identity for presentation; accepts model names and legacy ids. */

export type CanonicalToolName = "Read" | "Grep" | "Edit" | "RunCommand" | "WriteStdin";

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
  writestdin: "WriteStdin",
  "write-stdin": "WriteStdin",
  write_stdin: "WriteStdin",
  "workspace.write-stdin": "WriteStdin",
};

export function canonicalToolName(toolName: string): CanonicalToolName | undefined {
  return ALIASES[toolName.trim().toLowerCase()];
}
