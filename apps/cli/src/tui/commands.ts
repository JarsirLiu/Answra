/** TUI 本地 slash 命令解析；不触达 Agent 运行时。 */
export type TuiCommand =
  | { kind: "help" }
  | { kind: "clear" }
  | { kind: "exit" }
  | { kind: "unknown"; name: string };

export const TUI_HELP_LINES = [
  "本地命令：",
  "  /help    显示本帮助",
  "  /clear   清空当前会话 transcript",
  "  /exit    退出 TUI（/quit 同义）",
  "键盘：Ctrl+O 展开/收起思考与工具输出，PgUp/PgDn 或滚轮滚动 transcript。",
  "Home/End 只移动输入光标；Up/Down 浏览输入历史。",
  "全屏下滚轮/鼠标由 TUI 接管；复制请用终端原生选择（必要时按住 Shift）。",
  "其他输入会发送给 coding agent。",
] as const;

export function parseTuiCommand(text: string): TuiCommand | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const name = trimmed.slice(1).split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  switch (name) {
    case "help":
      return { kind: "help" };
    case "clear":
      return { kind: "clear" };
    case "exit":
    case "quit":
      return { kind: "exit" };
    default:
      return { kind: "unknown", name };
  }
}
