/** 原子文本写入与独占创建；保留编码/BOM/行尾/权限，失败时清理临时文件。 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { ToolExecutionError } from "../executor/result";
import { encodeText, type ToolTextEncoding } from "../text/encoding";
import { normalizeLineEndings, type ToolLineEndings } from "../text/lineEndings";
import { errorMessage, isAlreadyExists } from "./errors";
import { EDIT_FILE_MAX_BYTES } from "./limits";

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

export interface ToolTextCreateOptions {
  readonly maxBytes?: number;
  readonly mode?: number;
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

/** 以独占方式创建新文件；目标已存在时失败，不覆盖任何现有内容。 */
export async function createToolTextFileAtomic(
  target: string,
  text: string,
  options: ToolTextCreateOptions = {},
): Promise<ToolTextWriteResult> {
  const bytes = encodeText(normalizeLineEndings(text, "LF"), {
    encoding: "utf8",
    bom: false,
  });
  const maxBytes = options.maxBytes ?? EDIT_FILE_MAX_BYTES;
  if (bytes.length > maxBytes) {
    throw new ToolExecutionError(
      "invalid-input",
      `写入后文件 ${bytes.length} 字节，超过上限 ${maxBytes} 字节`,
    );
  }

  let handle: FileHandle | undefined;
  let created = false;
  try {
    handle = await fs.open(target, "wx", options.mode ?? 0o666);
    created = true;
    await handle.writeFile(bytes);
    await handle.sync();
    const stat = await handle.stat();
    await handle.close();
    handle = undefined;
    return { sizeBytes: stat.size, mtimeMs: stat.mtimeMs };
  } catch (error) {
    if (handle) await closeQuietly(handle);
    if (created) await removeQuietly(target);
    if (error instanceof ToolExecutionError) throw error;
    if (isAlreadyExists(error)) {
      throw new ToolExecutionError("invalid-input", "目标文件已存在，请先 Read 后再写入");
    }
    throw new ToolExecutionError("handler-failed", `创建文件失败：${errorMessage(error)}`);
  }
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
