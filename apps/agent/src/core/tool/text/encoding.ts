/** 文件工具的文本编码识别与投影；支持 UTF-8/UTF-16 BOM，拒绝二进制和未知编码。 */

import { ToolExecutionError } from "../executor/result";
import { detectLineEndings, type ToolLineEndings } from "./lineEndings";

export type ToolTextEncoding = "utf8" | "utf16le" | "utf16be";

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;
const UTF16LE_BOM = [0xff, 0xfe] as const;
const UTF16BE_BOM = [0xfe, 0xff] as const;

export interface DecodedEditableText {
  readonly text: string;
  readonly encoding: ToolTextEncoding;
  readonly bom: boolean;
  readonly lineEndings: ToolLineEndings;
}

export function decodeText(bytes: Uint8Array): string {
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

export function decodeEditableText(bytes: Uint8Array): DecodedEditableText {
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

export function encodeText(
  text: string,
  options: { readonly encoding: ToolTextEncoding; readonly bom: boolean },
): Buffer {
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
