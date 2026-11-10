/** Agent 进程内 Read/Grep/Edit 共用的文件路径、编码与写入能力；工作区只是默认根目录，不是访问边界。 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { ToolExecutionError } from "../executor/result";

export const READ_FILE_MAX_BYTES = 256 * 1024;
/** 带 offset/limit 的 Read 仍需避免无界读取；超过上限时明确失败。 */
export const READ_SCAN_MAX_BYTES = 16 * 1024 * 1024;
export const EDIT_FILE_MAX_BYTES = 1024 * 1024;

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

export async function resolveToolWriteFile(
  root: string | null,
  inputPath: string,
): Promise<string> {
  const target = await resolveToolTarget(root, inputPath);
  if (target.kind !== "file") throw new ToolExecutionError("invalid-input", "Agent 只能编辑文件");
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
  readonly mode: number;
}

export async function statToolFile(root: string | null, inputPath: string): Promise<ToolFileStat> {
  const target = await resolveToolFile(root, inputPath);
  const stat = await fs.stat(target);
  return { target, sizeBytes: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode & 0o777 };
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

export type ToolTextEncoding = "utf8" | "utf16le" | "utf16be";
export type ToolLineEndings = "LF" | "CRLF";

export interface ToolEditableTextFile {
  readonly text: string;
  readonly bytesRead: number;
  readonly encoding: ToolTextEncoding;
  readonly bom: boolean;
  readonly lineEndings: ToolLineEndings;
  readonly mtimeMs: number;
  readonly sizeBytes: number;
  readonly mode: number;
}

export async function readToolTextFileForEdit(
  target: string,
  maxBytes: number,
): Promise<ToolEditableTextFile> {
  const stat = await fs.stat(target);
  if (stat.size > maxBytes) {
    throw new ToolExecutionError(
      "invalid-input",
      `文件 ${stat.size} 字节，超过编辑上限 ${maxBytes} 字节`,
    );
  }
  const bytes = await fs.readFile(target);
  if (bytes.length > maxBytes) {
    throw new ToolExecutionError(
      "invalid-input",
      `文件 ${bytes.length} 字节，超过编辑上限 ${maxBytes} 字节`,
    );
  }
  const decoded = decodeEditableText(bytes);
  return {
    ...decoded,
    bytesRead: bytes.length,
    mtimeMs: stat.mtimeMs,
    mode: stat.mode & 0o777,
    sizeBytes: stat.size,
  };
}

export interface ToolTextWriteOptions {
  readonly encoding: ToolTextEncoding;
  readonly bom: boolean;
  readonly lineEndings: ToolLineEndings;
  readonly mode: number;
  readonly expectedMtimeMs: number;
  readonly expectedSizeBytes: number;
  readonly maxBytes?: number;
}

export interface ToolTextWriteResult {
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

export async function writeToolTextFileAtomic(
  target: string,
  text: string,
  options: ToolTextWriteOptions,
): Promise<ToolTextWriteResult> {
  const bytes = encodeText(normalizeLineEndings(text, options.lineEndings), options);
  const maxBytes = options.maxBytes ?? EDIT_FILE_MAX_BYTES;
  const directory = path.dirname(target);
  const temporaryPath = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;

  try {
    if (bytes.length > maxBytes) {
      throw new ToolExecutionError(
        "invalid-input",
        `编辑后文件 ${bytes.length} 字节，超过上限 ${maxBytes} 字节`,
      );
    }
    handle = await fs.open(temporaryPath, "wx", options.mode);
    await handle.chmod(options.mode);
    await handle.writeFile(bytes);
    await handle.sync();
    const temporaryStat = await handle.stat();
    await handle.close();
    handle = undefined;

    const current = await fs.stat(target);
    if (
      Math.trunc(current.mtimeMs) !== Math.trunc(options.expectedMtimeMs) ||
      current.size !== options.expectedSizeBytes
    ) {
      throw new ToolExecutionError("invalid-input", "文件在读取后已被修改，请重新读取后再编辑");
    }

    await fs.rename(temporaryPath, target);
    return { sizeBytes: temporaryStat.size, mtimeMs: temporaryStat.mtimeMs };
  } catch (error) {
    if (handle) await closeQuietly(handle);
    await removeQuietly(temporaryPath);
    if (error instanceof ToolExecutionError) throw error;
    throw new ToolExecutionError("handler-failed", `写入文件失败：${errorMessage(error)}`);
  }
}

function decodeEditableText(bytes: Uint8Array): {
  text: string;
  encoding: ToolTextEncoding;
  bom: boolean;
  lineEndings: ToolLineEndings;
} {
  if (startsWith(bytes, UTF8_BOM)) {
    const text = new TextDecoder("utf-8").decode(bytes);
    return { text, encoding: "utf8", bom: true, lineEndings: detectLineEndings(text) };
  }
  if (startsWith(bytes, UTF16LE_BOM)) {
    const text = new TextDecoder("utf-16le").decode(bytes);
    return { text, encoding: "utf16le", bom: true, lineEndings: detectLineEndings(text) };
  }
  if (startsWith(bytes, UTF16BE_BOM)) {
    const text = new TextDecoder("utf-16be").decode(bytes);
    return { text, encoding: "utf16be", bom: true, lineEndings: detectLineEndings(text) };
  }
  if (looksLikeBinary(bytes)) {
    throw new ToolExecutionError("invalid-input", "Agent 仅支持 UTF-8/UTF-16 纯文本文件");
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { text, encoding: "utf8", bom: false, lineEndings: detectLineEndings(text) };
  } catch {
    throw new ToolExecutionError("invalid-input", "Agent 仅支持 UTF-8/UTF-16 纯文本文件");
  }
}

function encodeText(text: string, options: { encoding: ToolTextEncoding; bom: boolean }): Buffer {
  switch (options.encoding) {
    case "utf8": {
      const body = Buffer.from(text, "utf8");
      return options.bom ? Buffer.concat([Buffer.from(UTF8_BOM), body]) : body;
    }
    case "utf16le": {
      const body = Buffer.from(text, "utf16le");
      return options.bom ? Buffer.concat([Buffer.from(UTF16LE_BOM), body]) : body;
    }
    case "utf16be": {
      const littleEndian = Buffer.from(text, "utf16le");
      const body = Buffer.allocUnsafe(littleEndian.length);
      for (let index = 0; index < littleEndian.length; index += 2) {
        body[index] = littleEndian[index + 1] ?? 0;
        body[index + 1] = littleEndian[index] ?? 0;
      }
      return options.bom ? Buffer.concat([Buffer.from(UTF16BE_BOM), body]) : body;
    }
  }
}

function normalizeLineEndings(text: string, lineEndings: ToolLineEndings): string {
  const normalized = text.replaceAll("\r\n", "\n");
  return lineEndings === "CRLF" ? normalized.replaceAll("\n", "\r\n") : normalized;
}

function detectLineEndings(text: string): ToolLineEndings {
  const totalLineFeeds = text.split("\n").length - 1;
  const crlfCount = text.split("\r\n").length - 1;
  const loneLineFeeds = totalLineFeeds - crlfCount;
  return crlfCount > 0 && crlfCount >= loneLineFeeds ? "CRLF" : "LF";
}

async function closeQuietly(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // 关闭失败不能掩盖原始写入错误。
  }
}

async function removeQuietly(target: string): Promise<void> {
  try {
    await fs.rm(target, { force: true });
  } catch {
    // 临时文件清理是尽力而为，原始错误优先。
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
