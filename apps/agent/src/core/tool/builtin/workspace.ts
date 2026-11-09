/** Agent 进程内 Read/Grep 共用的工作区文件边界；不涉及模型执行或事件写入。 */

import { promises as fs } from "node:fs";
import path from "node:path";

export const READ_FILE_MAX_BYTES = 256 * 1024;
/** 带 offset/limit 的 Read 仍需避免无界读取；超过上限时明确失败。 */
export const READ_SCAN_MAX_BYTES = 16 * 1024 * 1024;
export const GREP_FILE_MAX_BYTES = 128 * 1024;
export const WORKSPACE_MAX_DEPTH = 8;
export const WORKSPACE_MAX_FILES = 5_000;
/** 模型可见的工具输出上限；按字符计，避免多字节文本被提前截断。 */
export const TOOL_OUTPUT_MAX_CHARS = 20_000;

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;
const UTF16LE_BOM = [0xff, 0xfe] as const;
const UTF16BE_BOM = [0xfe, 0xff] as const;
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
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(absoluteRoot, ...relativePathSegments(inputPath));
  assertWithin(absoluteRoot, absoluteTarget);
  assertAllowedPath(absoluteRoot, absoluteTarget);
  const [realRoot, realTarget] = await Promise.all([
    fs.realpath(absoluteRoot),
    fs.realpath(absoluteTarget),
  ]);
  assertWithin(realRoot, realTarget);
  assertAllowedPath(realRoot, realTarget);
  return realTarget;
}

export interface WorkspaceFileStat {
  readonly target: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

export async function statWorkspaceFile(
  root: string,
  inputPath: string,
): Promise<WorkspaceFileStat> {
  const target = await resolveWorkspaceFile(root, inputPath);
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error("Agent 只能读取文件");
  return { target, sizeBytes: stat.size, mtimeMs: stat.mtimeMs };
}

export interface WorkspaceTextFile {
  readonly text: string;
  readonly bytesRead: number;
}

export async function readWorkspaceTextFile(
  target: string,
  maxBytes: number,
): Promise<WorkspaceTextFile> {
  const bytes = await fs.readFile(target);
  if (bytes.length > maxBytes) throw new Error("文件超过 Agent 单次读取上限");
  return { text: decodeText(bytes), bytesRead: bytes.length };
}

function relativePathSegments(inputPath: string): string[] {
  if (/^[a-zA-Z]:/.test(inputPath)) throw new Error("路径必须是工作区内的文件路径");
  const segments = inputPath.split(/[\\/]/);
  if (
    segments.some((segment) => !segment || segment === "." || segment === ".." || segment === "~")
  )
    throw new Error("路径必须是工作区内的文件路径");
  return segments;
}

function assertAllowedPath(root: string, target: string): void {
  const relative = path.relative(root, target);
  for (const segment of relative.split(path.sep)) {
    if (segment.startsWith(".") || IGNORED_DIRS.has(segment))
      throw new Error("Agent 不可访问隐藏文件或忽略目录中的内容");
  }
}

function decodeText(bytes: Uint8Array): string {
  if (startsWith(bytes, UTF8_BOM)) return new TextDecoder("utf-8").decode(bytes);
  if (startsWith(bytes, UTF16LE_BOM)) return new TextDecoder("utf-16le").decode(bytes);
  if (startsWith(bytes, UTF16BE_BOM)) return new TextDecoder("utf-16be").decode(bytes);
  if (looksLikeBinary(bytes)) throw new Error("Agent 仅支持 UTF-8/UTF-16 纯文本文件");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Agent 仅支持 UTF-8/UTF-16 纯文本文件");
  }
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

function looksLikeBinary(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  let controlBytes = 0;
  for (const byte of bytes) {
    if (byte === 0) return true;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) controlBytes += 1;
  }
  return controlBytes / bytes.length > 0.3;
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

function assertWithin(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("路径超出工作区范围");
}
