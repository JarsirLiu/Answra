/** 跨 chunk 文本解码：保留不完整 UTF-8 尾部，完整非法序列才回退 GBK。 */

import { isUtf8 } from "node:buffer";

/**
 * 会话输出跨 chunk 解码：UTF-8 多字节字符先留住不完整尾部，完整非法序列才回退 GBK。
 * 只在同一 stream 内使用；编码一旦回退，后续 chunk 继续按 GBK 解，避免逐 chunk 反复猜。
 */
export class StreamingShellDecoder {
  private pending: Buffer = Buffer.alloc(0);
  private mode: "utf8" | "gbk" = "utf8";
  private readonly gbk = new TextDecoder("gbk");

  write(chunk: Buffer): string {
    if (this.mode === "gbk") return this.gbk.decode(chunk, { stream: true });
    if (chunk.length === 0) return "";

    const bytes = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const completeLength = utf8CompleteLength(bytes);
    this.pending = bytes.subarray(completeLength);
    if (completeLength === 0) return "";

    const complete = bytes.subarray(0, completeLength);
    if (!isUtf8(complete)) {
      this.mode = "gbk";
      this.pending = Buffer.alloc(0);
      return this.gbk.decode(complete, { stream: true });
    }
    return complete.toString("utf8");
  }

  end(): string {
    const pending = this.pending;
    this.pending = Buffer.alloc(0);
    if (this.mode === "gbk") return this.gbk.decode();
    if (pending.length === 0) return "";
    if (isUtf8(pending)) return pending.toString("utf8");
    this.mode = "gbk";
    return this.gbk.decode(pending);
  }
}

function utf8CompleteLength(bytes: Buffer): number {
  let start = bytes.length - 1;
  while (start >= 0 && ((bytes[start] ?? 0) & 0b1100_0000) === 0b1000_0000) start -= 1;
  if (start < 0) return bytes.length;

  const expected = utf8SequenceLength(bytes[start] ?? 0);
  const available = bytes.length - start;
  if (expected <= available) return bytes.length;
  // 尾部看起来像不完整序列时，只有它前面的字节已经是合法 UTF-8 才能等待下一块。
  return isUtf8(bytes.subarray(0, start)) ? start : bytes.length;
}

function utf8SequenceLength(byte: number): number {
  if (byte < 0x80) return 1;
  if ((byte & 0b1110_0000) === 0b1100_0000) return 2;
  if ((byte & 0b1111_0000) === 0b1110_0000) return 3;
  if ((byte & 0b1111_1000) === 0b1111_0000) return 4;
  return 1;
}
