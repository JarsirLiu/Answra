/**
 * 工作区文件类型分派（纯函数，供树渲染与内容区选择预览组件）。
 */

export type WorkspaceFileKind = "markdown" | "docx" | "pdf" | "image" | "text" | "other";

export function classifyFile(fileName: string): WorkspaceFileKind {
  const ext = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "docx") return "docx";
  if (ext === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) return "image";
  if (["txt", "json"].includes(ext)) return "text";
  return "other";
}

/** 相对目录 + 相对/绝对引用 → 工作区内相对路径（POSIX 分隔）。 */
export function resolveRelative(currentDir: string, reference: string): string {
  const ref = reference.replace(/\\/g, "/").split("/").filter(Boolean);
  const base = currentDir.replace(/\\/g, "/").split("/").filter(Boolean);
  const stack = ref[0] === "/" ? [] : base;
  for (const segment of ref) {
    if (segment === ".") continue;
    if (segment === "..") stack.pop();
    else stack.push(segment);
  }
  return stack.join("/");
}

/** 相对路径 → answra-file:// 资源 URL（主进程自定义协议，限定工作区根目录内）。 */
export function toResourceUrl(relPath: string): string {
  return `answra-file:///${relPath.split("/").map(encodeURIComponent).join("/")}`;
}

/** 粘贴图片的落盘文件名（时间戳 + 随机后缀防冲突）。 */
export function pasteImageName(extension: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
  const random = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${random}.${extension}`;
}
