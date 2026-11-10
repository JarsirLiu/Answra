/** 按扩展名识别 Read 是否需要走文档抽取；真正的格式校验留在各抽取器。 */

import path from "node:path";
import type { ReadableDocumentFormat } from "./contracts";

const PDF_EXTENSION = ".pdf";
const DOC_EXTENSION = ".doc";
const DOCX_EXTENSION = ".docx";

export function detectDocumentFormat(filePath: string): ReadableDocumentFormat | undefined {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === PDF_EXTENSION) return "pdf";
  if (extension === DOC_EXTENSION) return "doc";
  if (extension === DOCX_EXTENSION) return "docx";
  return undefined;
}
