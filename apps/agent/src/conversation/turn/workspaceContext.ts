/** 把本轮工作区事实转成模型可读的系统上下文；只描述边界，不代替工具读取内容。 */

const WORKSPACE_HEADING = "# 工作区";
const NO_WORKSPACE_LINES = [
  WORKSPACE_HEADING,
  "用户尚未选择工作区目录，Read 与 Grep 当前不可用。",
  "不要调用这两个工具；用户询问笔记本内容时，请先请用户在「笔记本」面板选择目录。",
];
const WORKSPACE_USAGE_LINES = [
  "Read 的 file_path 与 Grep 的 path 都相对于该根目录；Grep 省略 path 时搜索整个工作区。",
  "需要了解有哪些文件时，用 Grep 搜索关键词或按字面文本检索，不要臆测文件名。",
  "回答工作区内容时只依据工具实际返回的内容。",
];

export function buildWorkspaceSystemContext(workspaceRoot: string | null): string {
  if (!workspaceRoot) return NO_WORKSPACE_LINES.join("\n");
  const lines = [WORKSPACE_HEADING, `当前工作区根目录：${workspaceRoot}`, ...WORKSPACE_USAGE_LINES];
  return lines.join("\n");
}
