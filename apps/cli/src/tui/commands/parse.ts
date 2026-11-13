/** TUI 本地 slash 命令解析：只把文本映射到目录 spec 与参数，不执行命令。 */
import { findTuiCommand, type TuiCommandSpec } from "./catalog";

export type TuiCommandInvocation =
  | { readonly command: TuiCommandSpec; readonly args: readonly string[] }
  | { readonly command?: undefined; readonly name: string };

export function parseTuiCommand(text: string): TuiCommandInvocation | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const parts = trimmed.slice(1).split(/\s+/).filter(Boolean);
  const name = parts[0]?.toLowerCase() ?? "";
  const command = findTuiCommand(name);
  return command === undefined ? { name } : { command, args: parts.slice(1) };
}
