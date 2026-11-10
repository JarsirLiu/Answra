/** Read 的文档分派：识别格式、读取字节、执行 PDF/Word 抽取并返回模型元数据。 */

import { promises as fs } from "node:fs";
import { ToolExecutionError } from "../../executor/result";
import type { ReadDocumentMetadata } from "./contracts";
import { detectDocumentFormat } from "./documentFormat";
import { extractPdfText } from "./pdfText";
import { extractWordText } from "./wordText";

/** 文档抽取的输入上限；超过后由 Read 返回明确失败，不做静默截断。 */
export const READ_DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;

const WORD_BODY_ONLY_NOTICE = "已按纯文本抽取 Word 正文；页眉、页脚、批注和图片未包含。";

export interface DocumentTextRead {
  readonly text: string;
  readonly metadata: ReadDocumentMetadata;
}

export async function readDocumentText(
  filePath: string,
  sizeBytes: number,
  signal: AbortSignal,
): Promise<DocumentTextRead | undefined> {
  const format = detectDocumentFormat(filePath);
  if (!format) return undefined;

  if (sizeBytes > READ_DOCUMENT_MAX_BYTES) {
    throw new ToolExecutionError(
      "output-too-large",
      `文档 ${sizeBytes} 字节，超过单次读取上限 ${READ_DOCUMENT_MAX_BYTES} 字节。`,
    );
  }

  const bytes = await fs.readFile(filePath);
  if (bytes.length > READ_DOCUMENT_MAX_BYTES) {
    throw new ToolExecutionError(
      "output-too-large",
      `文档 ${bytes.length} 字节，超过单次读取上限 ${READ_DOCUMENT_MAX_BYTES} 字节。`,
    );
  }

  if (format === "pdf") {
    const extracted = await extractPdfText(bytes, signal);
    if (extracted.emptyPageCount === extracted.pageCount) {
      throw new ToolExecutionError(
        "invalid-input",
        "PDF 没有可提取文本（可能是扫描件），无法读取。",
      );
    }
    return {
      text: extracted.text,
      metadata: {
        format,
        pageCount: extracted.pageCount,
        emptyPageCount: extracted.emptyPageCount,
        notices: [],
      },
    };
  }

  const extracted = await extractWordText(bytes, signal);
  return {
    text: extracted.text,
    metadata: { format, notices: [WORD_BODY_ONLY_NOTICE] },
  };
}
