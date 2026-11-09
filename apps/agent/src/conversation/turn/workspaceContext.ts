/** 把本轮工作区事实转成模型可读的系统上下文；只描述默认根目录，不代替工具读取内容。 */

const WORKSPACE_HEADING = "# 工作区";
const NO_WORKSPACE_LINES = [
  WORKSPACE_HEADING,
  "用户尚未选择工作区目录。Read 与 Grep 仍可使用，但必须提供绝对路径。",
  "用户询问笔记本内容时，建议先请用户在「笔记本」面板选择目录，以便使用相对路径和默认搜索范围。",
  "工作区不是访问边界；用户明确指向其他目录时，可使用对应绝对路径。",
];
const WORKSPACE_USAGE_LINES = [
  "Read 的 file_path 与 Grep 的 path 可以相对于该根目录，也可以使用任意绝对路径；Grep 省略 path 时搜索整个工作区。",
  "优先在当前工作区内查找；只有用户明确要求或工作区没有所需内容时，再访问其他目录。",
  "工作区不是访问边界；用户明确指向其他目录时，可使用对应绝对路径。",
  "需要了解有哪些文件时，用 Grep 搜索关键词或正则，不要臆测文件名。",
  "回答工作区内容时只依据工具实际返回的内容。",
];

export function buildWorkspaceSystemContext(workspaceRoot: string | null): string {
  if (!workspaceRoot) return NO_WORKSPACE_LINES.join("\n");
  const lines = [WORKSPACE_HEADING, `当前工作区根目录：${workspaceRoot}`, ...WORKSPACE_USAGE_LINES];
  return lines.join("\n");
}
