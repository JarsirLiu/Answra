/** Agent-process filesystem boundaries shared by conversation Read and Grep. */

import { promises as fs } from "node:fs";
import path from "node:path";

export const TEXT_FILE_MAX_BYTES = 128 * 1024;
export const WORKSPACE_MAX_DEPTH = 8;
export const WORKSPACE_MAX_FILES = 5_000;
export const TOOL_OUTPUT_MAX_CHARS = 20_000;

const IGNORED_DIRS = new Set(["node_modules", ".git", ".svn", "dist", "out"]);
const TEXT_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".json",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".css",
  ".html",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".csv",
]);

export function requireWorkspaceRoot(root: string | null): string {
  if (!root) throw new Error("尚未选择工作区目录");
  return root;
}

export function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("工具调用已取消");
}

export async function resolveWorkspaceFile(root: string, inputPath: string): Promise<string> {
  if (!inputPath || inputPath.length > 1024) throw new Error("文件路径无效");
  const segments = inputPath.split(/[\\/]/);
  if (
    path.isAbsolute(inputPath) ||
    /^[a-zA-Z]:/.test(inputPath) ||
    segments.some((segment) => !segment || segment === "." || segment === ".." || segment === "~")
  )
    throw new Error("路径必须是工作区内的相对文件路径");
  if (segments.some((segment) => segment.startsWith(".") || IGNORED_DIRS.has(segment)))
    throw new Error("Agent 不可访问隐藏文件或忽略目录中的内容");

  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(absoluteRoot, ...segments);
  assertWithin(absoluteRoot, absoluteTarget);
  const [realRoot, realTarget] = await Promise.all([
    fs.realpath(absoluteRoot),
    fs.realpath(absoluteTarget),
  ]);
  assertWithin(realRoot, realTarget);
  return realTarget;
}

export async function readWorkspaceText(root: string, inputPath: string): Promise<string> {
  const target = await resolveWorkspaceFile(root, inputPath);
  if (!TEXT_EXTENSIONS.has(path.extname(target).toLowerCase()))
    throw new Error("Agent 仅支持读取纯文本文件");
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error("Agent 只能读取文件");
  if (stat.size > TEXT_FILE_MAX_BYTES) throw new Error("文件超过 Agent 单次读取上限");
  const bytes = await fs.readFile(target);
  if (bytes.length > TEXT_FILE_MAX_BYTES) throw new Error("文件超过 Agent 单次读取上限");
  return bytes.toString("utf8");
}

export async function collectWorkspaceTextFiles(
  root: string,
  signal: AbortSignal,
): Promise<string[]> {
  const files: string[] = [];
  const realRoot = await fs.realpath(root);
  async function visit(directory: string, depth: number): Promise<void> {
    assertNotAborted(signal);
    if (depth > WORKSPACE_MAX_DEPTH) return;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      assertNotAborted(signal);
      if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(target, depth + 1);
      else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(target);
        if (files.length >= WORKSPACE_MAX_FILES) return;
      }
      if (files.length >= WORKSPACE_MAX_FILES) return;
    }
  }
  await visit(realRoot, 0);
  return files;
}

export function relativeWorkspacePath(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/");
}

export function truncateToolOutput(value: string): string {
  if (value.length <= TOOL_OUTPUT_MAX_CHARS) return value;
  return `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[输出已截断]`;
}

function assertWithin(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("路径超出工作区范围");
}
