/** 会话 workspace 比较键：Windows 路径大小写不敏感；不改变对外展示路径。 */
export function workspaceStorageKey(
  root: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32" ? root.toLowerCase() : root;
}
