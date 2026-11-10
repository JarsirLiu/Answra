/** Word 文本抽取：word-extractor 同时处理 OLE(.doc) 与 OpenXML(.docx)，不依赖 Office。 */

import WordExtractor from "word-extractor";
import { ToolExecutionError } from "../../executor/result";

export interface WordTextExtraction {
  readonly text: string;
}

export async function extractWordText(
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<WordTextExtraction> {
  throwIfAborted(signal);

  let text: string;
  try {
    const document = await new WordExtractor().extract(Buffer.from(bytes));
    text = normalizeWordText(document.getBody());
  } catch (error) {
    throw new ToolExecutionError("invalid-input", describeWordError(error));
  }

  throwIfAborted(signal);
  if (!text) {
    throw new ToolExecutionError("invalid-input", "Word 文档没有可提取的正文文本。");
  }
  return { text };
}

function normalizeWordText(value: string): string {
  return value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function describeWordError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("Unable to read this type of file")) {
    return "文件不是可识别的 Word 文档。";
  }
  return "Word 文档解析失败：文件可能损坏、加密或格式不受支持。";
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ToolExecutionError("aborted", "工具调用已取消。");
}
