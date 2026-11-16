/** 文本文件读取与编辑基线；路径解析、编码和写盘分别由相邻模块负责。 */

import { promises as fs } from "node:fs";
import { ToolExecutionError } from "../executor/result";
import { decodeEditableText, decodeText, type ToolTextEncoding } from "../text/encoding";
import type { ToolLineEndings } from "../text/lineEndings";
import { resolveToolFile } from "./paths";

export interface ToolFileStat {
  readonly target: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  readonly mode: number;
}

export interface ToolTextFile {
  readonly text: string;
  readonly bytesRead: number;
}

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

export async function statToolFile(root: string | null, inputPath: string): Promise<ToolFileStat> {
  const target = await resolveToolFile(root, inputPath);
  const stat = await fs.stat(target);
  return { target, sizeBytes: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode & 0o777 };
}

export async function readToolTextFile(target: string, maxBytes: number): Promise<ToolTextFile> {
  const bytes = await fs.readFile(target);
  if (bytes.length > maxBytes) throw new Error("文件超过 Agent 单次读取上限");
  return { text: decodeText(bytes), bytesRead: bytes.length };
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
