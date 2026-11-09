/** 把本轮工作区事实转成模型可读的系统上下文；只描述默认根目录，不代替工具读取内容。 */

const WORKSPACE_HEADING = "# 工作区";
const NO_WORKSPACE_LINES = [
  WORKSPACE_HEADING,
  "用户尚未选择工作区目录；相对路径不可解析，查看文件时必须使用绝对路径。",
  "用户询问笔记本内容时，可建议其先在「笔记本」面板选择目录。",
  "工作区不是访问边界；用户明确指向其他目录时，可使用对应绝对路径。",
];
const WORKSPACE_USAGE_LINES = [
  "相对路径以该根目录为默认基线，也可以使用任意绝对路径；省略路径时默认查看整个工作区。",
  "优先在当前工作区内查找；用户明确要求或工作区没有所需内容时，再查看其他目录。",
  "工作区不是访问边界；用户明确指向其他目录时，可使用对应绝对路径。",
  "回答目录内容时只依据实际读取到的内容，不要猜测文件名或内容。",
];

export function buildWorkspaceSystemContext(workspaceRoot: string | null): string {
  if (!workspaceRoot) return NO_WORKSPACE_LINES.join("\n");
  const lines = [WORKSPACE_HEADING, `当前工作区根目录：${workspaceRoot}`, ...WORKSPACE_USAGE_LINES];
  return lines.join("\n");
}
