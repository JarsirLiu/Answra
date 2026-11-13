/** TUI 本地 slash 命令解析；不触达 Agent 运行时。 */
import { findTuiCommand } from "./catalog";

export type TuiCommand =
  | { kind: "help" }
  | { kind: "clear" }
  | { kind: "exit" }
  | { kind: "model"; args: readonly string[] }
  | { kind: "unknown"; name: string };

export function parseTuiCommand(text: string): TuiCommand | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const parts = trimmed.slice(1).split(/\s+/).filter(Boolean);
  const name = parts[0]?.toLowerCase() ?? "";
  const command = findTuiCommand(name);
  if (command === undefined) return { kind: "unknown", name };
  switch (command.kind) {
    case "help":
      return { kind: "help" };
    case "clear":
      return { kind: "clear" };
    case "exit":
      return { kind: "exit" };
    case "model":
      return { kind: "model", args: parts.slice(1) };
  }
}
