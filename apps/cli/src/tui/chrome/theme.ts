/** 对齐 Claude Code dark theme 的终端色板；只放 TUI 颜色，不放业务状态。 */
export const TUI_THEME = {
  claude: "#d77757",
  claudeShimmer: "#f59575",
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
export const POINTER = "❯";
