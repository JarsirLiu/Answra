/** Agent 进程内 Read/Grep 共用的文件路径解析；工作区只是默认根目录，不是访问边界。 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { ToolExecutionError } from "../executor/result";

export const READ_FILE_MAX_BYTES = 256 * 1024;
/** 带 offset/limit 的 Read 仍需避免无界读取；超过上限时明确失败。 */
export const READ_SCAN_MAX_BYTES = 16 * 1024 * 1024;

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;
const UTF16LE_BOM = [0xff, 0xfe] as const;
const UTF16BE_BOM = [0xfe, 0xff] as const;
const VCS_DIRS = new Set([".git", ".svn", ".hg", ".bzr", ".jj", ".sl"]);

export function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("工具调用已取消");
}

export async function resolveToolFile(root: string | null, inputPath: string): Promise<string> {
  const target = await resolveToolTarget(root, inputPath);
  if (target.kind !== "file") throw new ToolExecutionError("invalid-input", "Agent 只能读取文件");
  return target.target;
}

export interface ToolTarget {
  readonly target: string;
  readonly kind: "file" | "directory";
  readonly searchRoot: string;
  readonly guestPath: string;
}

export async function resolveToolTarget(
  root: string | null,
  inputPath: string,
): Promise<ToolTarget> {
  const absoluteTarget = resolveInputPath(root, inputPath);
  assertAllowedPath(absoluteTarget);
  const realTarget = await fs.realpath(absoluteTarget);
  assertAllowedPath(realTarget);
  const stat = await fs.stat(realTarget);
  if (!stat.isFile() && !stat.isDirectory())
    throw new ToolExecutionError("invalid-input", "Agent 只能访问文件或目录");
  const isFile = stat.isFile();
  return {
    target: realTarget,
    kind: isFile ? "file" : "directory",
    searchRoot: isFile ? path.dirname(realTarget) : realTarget,
    guestPath: isFile ? `./${path.basename(realTarget)}` : ".",
  };
}

export interface ToolFileStat {
  readonly target: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

export async function statToolFile(root: string | null, inputPath: string): Promise<ToolFileStat> {
  const target = await resolveToolFile(root, inputPath);
  const stat = await fs.stat(target);
  return { target, sizeBytes: stat.size, mtimeMs: stat.mtimeMs };
}

export interface ToolTextFile {
  readonly text: string;
  readonly bytesRead: number;
}

export async function readToolTextFile(target: string, maxBytes: number): Promise<ToolTextFile> {
  const bytes = await fs.readFile(target);
  if (bytes.length > maxBytes) throw new Error("文件超过 Agent 单次读取上限");
  return { text: decodeText(bytes), bytesRead: bytes.length };
}

function resolveInputPath(root: string | null, inputPath: string): string {
  if (!inputPath || inputPath.length > 1024)
    throw new ToolExecutionError("invalid-input", "文件路径无效");
  if (path.isAbsolute(inputPath)) return path.resolve(inputPath);
  if (/^[a-zA-Z]:/.test(inputPath))
    throw new ToolExecutionError("invalid-input", "路径不能是盘符相对形式");
  if (!root)
    throw new ToolExecutionError(
      "invalid-input",
      "使用相对路径前请先选择工作区目录，或提供绝对路径",
    );
  return path.resolve(root, inputPath);
}

function assertAllowedPath(target: string): void {
  for (const segment of path.resolve(target).split(path.sep)) {
    if (VCS_DIRS.has(segment))
      throw new ToolExecutionError("invalid-input", "Agent 不可访问版本库目录中的内容");
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
