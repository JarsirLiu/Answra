/** CLI 标准输入端口：只暴露 TTY 判定与一次性读取，不把流泄漏到业务层。 */
import type { Readable } from "node:stream";

export interface InputPort {
  readonly isTTY: boolean;
  readAll(): Promise<string>;
}

export function createProcessInput(stdin: Readable & { isTTY?: boolean }): InputPort {
  return {
    isTTY: stdin.isTTY === true,
    readAll: () => readAllText(stdin),
  };
}

async function readAllText(stream: Readable): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
  }
  return chunks.join("");
}
