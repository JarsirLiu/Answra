/**
 * 项目根发现：从起始目录向上找到最近的 `.git`。
 * 只提供本地磁盘事实，不拼接任何具体文件；AGENTS.md 与 skill 共用同一边界规则。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const PROJECT_MARKER = ".git";

/**
 * 最近的 `.git` 目录即为项目根；找不到时返回起始目录本身。
 * 返回绝对路径，调用方可以直接拼接文件名。
 */
export async function findProjectRoot(start: string): Promise<string> {
  const resolved = path.resolve(start);
  let current = resolved;
  while (true) {
    if (await pathExists(path.join(current, PROJECT_MARKER))) return current;
    const parent = path.dirname(current);
    if (parent === current) return resolved;
    current = parent;
  }
}

/**
 * 返回从项目根到起始目录的目录链（含两端）。
 * 没有 `.git` 时只有起始目录，避免误读工作区之外任意父目录。
 */
export async function discoverProjectDirectories(start: string): Promise<readonly string[]> {
  const resolved = path.resolve(start);
  const stop = await findProjectRoot(resolved);
  const directories: string[] = [];
  let current = resolved;
  while (true) {
    directories.push(current);
    if (pathKey(current) === pathKey(stop)) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return directories.reverse();
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

/** Windows 路径大小写不敏感；比较前不能依赖字符串原样相等。 */
function pathKey(target: string): string {
  return process.platform === "win32" ? target.toLowerCase() : target;
}
