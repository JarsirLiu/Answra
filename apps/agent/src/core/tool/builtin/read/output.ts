/** Read 的结构化文本输出、token 预算与模型可见投影；不读写文件系统。 */

import type { ReadDocumentMetadata } from "./documents/contracts";

const ESTIMATED_TOKEN_CHAR_DIVISOR = 3;

export const READ_MAX_OUTPUT_TOKENS = 25_000;
export const READ_DEFAULT_MAX_LINES = 2_000;
const READ_TOKEN_BUDGET_PARTIAL_TARGET = Math.floor(READ_MAX_OUTPUT_TOKENS * 0.85);
const EMPTY_FILE_REMINDER = "<system-reminder>文件存在，但内容为空。</system-reminder>";
const FILE_UNCHANGED_STUB =
  "Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.";

export interface ReadTextOutput {
  readonly type: "text";
  readonly filePath: string;
  readonly content: string;
  readonly numLines: number;
  readonly startLine: number;
  readonly totalLines: number;
  readonly sizeBytes?: number;
  readonly bytesRead?: number;
  readonly truncated?: boolean;
  readonly truncatedByTokenCap?: boolean;
  readonly partialViewNotice?: string;
  readonly document?: ReadDocumentMetadata;
}

export interface ReadUnchangedOutput {
  readonly type: "file_unchanged";
  readonly filePath: string;
}

export type ReadOutput = ReadTextOutput | ReadUnchangedOutput;

export class ReadOutputTooLargeError extends Error {
  constructor(
    readonly tokenCount: number,
    readonly filePath: string,
  ) {
    super(
      `文件内容约 ${tokenCount} tokens，超过单次读取上限 ${READ_MAX_OUTPUT_TOKENS}。请使用 offset 和 limit 读取指定范围，或使用 Grep 定位。`,
    );
    this.name = "ReadOutputTooLargeError";
  }
}

export function createReadTextOutput(input: {
  bytesRead: number;
  filePath: string;
  limit?: number;
  offset?: number;
  sizeBytes: number;
  text: string;
  document?: ReadDocumentMetadata;
}): ReadTextOutput {
  const lines = splitLines(input.text);
  const startLine = normalizeOffset(input.offset);
  const startIndex = startLine - 1;
  const limit = normalizeLimit(input.limit);
  const selected =
    limit === undefined ? lines.slice(startIndex) : lines.slice(startIndex, startIndex + limit);
  const content = selected.join("\n");
  const tokenCount = estimateTokens(content);
  const output = {
    type: "text" as const,
    filePath: input.filePath,
    content,
    numLines: selected.length,
    startLine,
    totalLines: lines.length,
    sizeBytes: input.sizeBytes,
    bytesRead: input.bytesRead,
    truncated: false,
    ...(input.document ? { document: input.document } : {}),
  };

  if (tokenCount <= READ_MAX_OUTPUT_TOKENS) return output;

  const allowPartialFallback = startLine <= 1 && limit === undefined;
  if (!allowPartialFallback) throw new ReadOutputTooLargeError(tokenCount, input.filePath);

  const partial = createTokenCapPartialView({
    lines: selected,
    startLine,
    tokenCount,
    totalLines: lines.length,
  });
  if (!partial) throw new ReadOutputTooLargeError(tokenCount, input.filePath);
  return {
    type: "text",
    filePath: input.filePath,
    sizeBytes: input.sizeBytes,
    bytesRead: input.bytesRead,
    ...(input.document ? { document: input.document } : {}),
    ...partial,
  };
}

export function formatReadOutput(output: ReadOutput): string {
  switch (output.type) {
    case "file_unchanged":
      return FILE_UNCHANGED_STUB;
    case "text":
      return formatReadTextOutput(output);
  }
}

function formatReadTextOutput(output: ReadTextOutput): string {
  const prefixParts: string[] = [];
  if (output.document) prefixParts.push(formatDocumentContext(output.document));
  if (output.partialViewNotice) {
    prefixParts.push(formatReadToolResultWarning(output.partialViewNotice));
  }
  const prefix = prefixParts.length > 0 ? `${prefixParts.join("\n\n")}\n\n` : "";
  if (!output.content) {
    const warning =
      output.totalLines === 0
        ? EMPTY_FILE_REMINDER
        : formatReadToolResultWarning(
            `文件只有 ${output.totalLines} 行，offset=${output.startLine} 超出范围。`,
          );
    return `${prefix}${warning}`;
  }
  return `${prefix}${addReadLineNumbers({ content: output.content, startLine: output.startLine })}`;
}

function addReadLineNumbers(input: { content: string; startLine: number }): string {
  return input.content
    .split("\n")
    .map((line, index) => `${index + input.startLine}\t${line}`)
    .join("\n");
}

function createTokenCapPartialView(input: {
  lines: readonly string[];
  startLine: number;
  tokenCount: number;
  totalLines: number;
}): Omit<ReadTextOutput, "bytesRead" | "filePath" | "sizeBytes" | "type"> | undefined {
  const lineCount = findLargestPrefixWithinTokenBudget(input.lines);
  if (lineCount > 0) {
    const content = input.lines.slice(0, lineCount).join("\n");
    const endLine = input.startLine + lineCount - 1;
    return {
      content,
      numLines: lineCount,
      startLine: input.startLine,
      totalLines: input.totalLines,
      truncated: true,
      truncatedByTokenCap: true,
      partialViewNotice: [
        `文件内容约 ${input.tokenCount} tokens，超过单次读取上限 ${READ_MAX_OUTPUT_TOKENS}。`,
        `仅显示第 ${input.startLine}-${endLine} 行（共 ${input.totalLines} 行）。`,
        `继续读取请使用 offset=${endLine + 1} 和 limit=${READ_DEFAULT_MAX_LINES}，或使用 Grep 定位。`,
      ].join(" "),
    };
  }

  const charCount = findLargestPrefixCharsWithinTokenBudget(input.lines.join("\n"));
  if (charCount <= 0) return undefined;
  return {
    content: input.lines.join("\n").slice(0, charCount),
    numLines: 1,
    startLine: input.startLine,
    totalLines: input.totalLines,
    truncated: true,
    truncatedByTokenCap: true,
    partialViewNotice: [
      `文件内容约 ${input.tokenCount} tokens，超过单次读取上限 ${READ_MAX_OUTPUT_TOKENS}。`,
      "第一行本身超过预算，已截断。",
      "请缩小读取范围，或使用 Grep 定位。",
    ].join(" "),
  };
}

function findLargestPrefixWithinTokenBudget(lines: readonly string[]): number {
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(lines.slice(0, mid).join("\n")) <= READ_TOKEN_BUDGET_PARTIAL_TARGET) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

function findLargestPrefixCharsWithinTokenBudget(content: string): number {
  let low = 0;
  let high = content.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(content.slice(0, mid)) <= READ_TOKEN_BUDGET_PARTIAL_TARGET) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

/** 中文字符按两个字符计入，再按除数折算。 */
function estimateTokens(text: string): number {
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil((chineseChars * 2 + otherChars) / ESTIMATED_TOKEN_CHAR_DIVISOR);
}

function splitLines(text: string): string[] {
  const normalized = text.replaceAll("\r\n", "\n");
  return normalized.length === 0 ? [] : normalized.split("\n");
}

function normalizeOffset(offset: number | undefined): number {
  return offset === undefined ? 1 : Math.max(1, Math.trunc(offset));
}

function normalizeLimit(limit: number | undefined): number | undefined {
  return limit === undefined ? undefined : Math.max(1, Math.trunc(limit));
}

function formatDocumentContext(metadata: ReadDocumentMetadata): string {
  if (metadata.format === "pdf") {
    const pageCount = metadata.pageCount ?? 0;
    const emptyPageCount = metadata.emptyPageCount ?? 0;
    const emptySuffix = emptyPageCount > 0 ? `，其中 ${emptyPageCount} 页没有可提取文本` : "";
    return formatReadToolResultWarning(`已从 PDF 抽取文本（共 ${pageCount} 页${emptySuffix}）。`);
  }
  const notice =
    metadata.notices.length > 0 ? metadata.notices.join(" ") : "已从 Word 文档抽取正文文本。";
  return formatReadToolResultWarning(notice);
}

function formatReadToolResultWarning(body: string): string {
  return `<system-reminder>${body}</system-reminder>`;
}
