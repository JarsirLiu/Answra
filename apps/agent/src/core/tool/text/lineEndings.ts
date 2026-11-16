/** 文本行尾检测与归一化；只处理 LF/CRLF，不读写文件。 */

export type ToolLineEndings = "LF" | "CRLF";

export function normalizeLineEndings(text: string, lineEndings: ToolLineEndings): string {
  const normalized = text.replaceAll("\r\n", "\n");
  return lineEndings === "CRLF" ? normalized.replaceAll("\n", "\r\n") : normalized;
}

export function detectLineEndings(text: string): ToolLineEndings {
  const totalLineFeeds = text.split("\n").length - 1;
  const crlfCount = text.split("\r\n").length - 1;
  const loneLineFeeds = totalLineFeeds - crlfCount;
  return crlfCount > 0 && crlfCount >= loneLineFeeds ? "CRLF" : "LF";
}
