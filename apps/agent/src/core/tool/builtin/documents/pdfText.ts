/** PDF 文本抽取：pdfjs 在 Agent 进程内逐页取文本，不渲染页面、不依赖外部二进制。 */

import { ToolExecutionError } from "../../executor/result";

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;
const EMPTY_PAGE_TEXT = "[本页无可提取文本]";

export interface PdfTextExtraction {
  readonly text: string;
  readonly pageCount: number;
  readonly emptyPageCount: number;
}

export async function extractPdfText(
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<PdfTextExtraction> {
  if (!startsWith(bytes, PDF_MAGIC)) {
    throw new ToolExecutionError("invalid-input", "不是有效 PDF（缺少 %PDF- 文件头）。");
  }

  const worker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const loadingTask = getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: false,
    useWorkerFetch: false,
    verbosity: 0,
  });

  let pdf: Awaited<typeof loadingTask.promise>;
  try {
    pdf = await loadingTask.promise;
  } catch (error) {
    throw mapPdfError(error);
  }

  try {
    throwIfAborted(signal);
    if (pdf.numPages === 0) {
      throw new ToolExecutionError("invalid-input", "PDF 没有任何页面。");
    }

    const pages: string[] = [];
    let emptyPageCount = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      throwIfAborted(signal);
      const page = await pdf.getPage(pageNumber);
      try {
        const text = readPageText(await page.getTextContent());
        if (text) {
          pages.push(`${formatPageMarker(pageNumber)}\n${text}`);
        } else {
          emptyPageCount += 1;
          pages.push(`${formatPageMarker(pageNumber)}\n${EMPTY_PAGE_TEXT}`);
        }
      } finally {
        page.cleanup();
      }
    }

    return { text: pages.join("\n\n"), pageCount: pdf.numPages, emptyPageCount };
  } finally {
    await pdf.destroy().catch(() => undefined);
  }
}

function readPageText(content: { readonly items: ReadonlyArray<unknown> }): string {
  const chunks: string[] = [];
  for (const item of content.items) {
    if (typeof item !== "object" || item === null || !("str" in item)) continue;
    if (typeof item.str !== "string") continue;
    chunks.push(item.str);
    if ("hasEOL" in item && item.hasEOL === true) chunks.push("\n");
  }
  return chunks
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ToolExecutionError("aborted", "工具调用已取消。");
}

function formatPageMarker(pageNumber: number): string {
  return `--- 第 ${pageNumber} 页 ---`;
}

function mapPdfError(error: unknown): ToolExecutionError {
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String((error as { name?: unknown }).name)
      : "";
  switch (name) {
    case "PasswordException":
      return new ToolExecutionError("invalid-input", "PDF 已加密，无法读取。");
    case "InvalidPDFException":
    case "MissingPDFException":
      return new ToolExecutionError("invalid-input", "PDF 文件损坏或格式无效。");
    default:
      return new ToolExecutionError("handler-failed", "PDF 文本抽取失败。");
  }
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}
