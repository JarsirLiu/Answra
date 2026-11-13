/** TUI `/help` 文案；命令用法来自 catalog，本文件只负责对齐与排版。 */
import stringWidth from "string-width";
import { TUI_COMMANDS, tuiCommandHelpUsage } from "./catalog";

const HELP_USAGE_COLUMN = 32;

const TUI_HELP_FOOTER = [
  "输入 / 查看命令，Tab 补全；Enter 发送或排队。",
  "键盘：Ctrl+O 展开/收起思考与工具输出，PgUp/PgDn 或滚轮滚动 transcript。",
  "鼠标：全屏下拖选对话文本，释放自动复制；Ctrl+Shift+C / Cmd+C 复制选区，Ctrl+Shift+A 全选可见对话，Esc 清除选区。",
  "输入框：Home/End 移动当前显示行光标，Up/Down 先在多行内移动，到边界再浏览历史。",
  "--no-alt-screen 下不接管鼠标，使用终端原生选择/复制。",
  "其他输入会发送给 coding agent。",
] as const;

export const TUI_HELP_LINES: readonly string[] = [
  "本地命令：",
  ...TUI_COMMANDS.flatMap((command) => [
    formatCommandLine(tuiCommandHelpUsage(command), command.summary),
    ...(command.helpDetails ?? []).map((detail) => formatCommandLine(detail.usage, detail.summary)),
  ]),
  ...TUI_HELP_FOOTER,
];

function formatCommandLine(usage: string, summary: string): string {
  const padding = Math.max(2, HELP_USAGE_COLUMN - stringWidth(usage));
  return `  ${usage}${" ".repeat(padding)}${summary}`;
}
