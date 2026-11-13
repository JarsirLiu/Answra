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
  "鼠标：全屏下拖选对话文本，释放自动复制；Ctrl+Shift+C / Cmd+C 复制选区，Ctrl+Shift+A 全选可见对话，Esc 清除选区。",
  "输入框：Home/End 移动当前显示行光标，Up/Down 先在多行内移动，到边界再浏览历史。",
  "--no-alt-screen 下不接管鼠标，使用终端原生选择/复制。",
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
