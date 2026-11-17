/** 元命令：/help 与 /exit；只做面板与退出转发。 */
import type { TuiCommandDeps } from "../ports";

export function handleHelp(_args: readonly string[], deps: TuiCommandDeps): void {
  deps.openPanel("help");
}

export function handleExit(_args: readonly string[], deps: TuiCommandDeps): void {
  deps.requestExit();
}
