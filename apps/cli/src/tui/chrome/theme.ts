/** 对齐 Claude Code dark theme 的终端色板与跨终端符号；不放业务状态。 */
export const TUI_THEME = {
  claude: "#d77757",
  claudeShimmer: "#f59575",
  compaction: "#5769f7",
  text: "#ffffff",
  inverseText: "#000000",
  inactive: "#999999",
  inactiveShimmer: "#c1c1c1",
  suggestion: "#b1b9f9",
  background: "#00cccc",
  success: "#4eba65",
  error: "#ff6b80",
  warning: "#ffc107",
  diffAdded: "#225c2b",
  diffRemoved: "#7a2936",
  promptBorder: "#888888",
  userMessageBackground: "#373737",
  messageActionsBackground: "#2c323e",
  code: "#b1b9f9",
  codeBlock: "#c1c1c1",
} as const;

export const SPINNER_FRAMES = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"] as const;
export const BLACK_CIRCLE = "⏺";
/** Windows 控制台字体常缺 U+276F 字形，聚焦指针回退为 ASCII。 */
export const POINTER = process.platform === "win32" ? ">" : "❯";
