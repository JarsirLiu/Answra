/** Bounded text primitives shared by every tool presenter. */

export const TOOL_SUMMARY_MAX_CHARS = 80;
export const TOOL_DETAIL_MAX_CHARS = 20_000;
export const TOOL_DETAIL_MAX_LINES = 400;
export const TOOL_JSON_MAX_CHARS = 4_000;
export const TOOL_LIST_MAX_ITEMS = 50;

export interface ClippedText {
  readonly text: string;
  readonly truncated: boolean;
  readonly totalLines: number;
}

/** Collapses whitespace and clips to one summary line. */
export function oneLine(value: string, maxChars = TOOL_SUMMARY_MAX_CHARS): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${clipCodeUnits(normalized, Math.max(0, maxChars - 1))}…`;
}

/** Clips detail text by line and character budgets while preserving indentation. */
export function clipDetailText(value: string): ClippedText {
  const normalized = value.replaceAll("\r\n", "\n").replace(/\s+$/u, "");
  const lines = normalized.length === 0 ? [] : normalized.split("\n");
  const totalLines = lines.length;
  const limited = lines.slice(0, TOOL_DETAIL_MAX_LINES);
  let text = limited.join("\n");
  let truncated = lines.length > TOOL_DETAIL_MAX_LINES;
  if (text.length > TOOL_DETAIL_MAX_CHARS) {
    text = clipCodeUnits(text, TOOL_DETAIL_MAX_CHARS);
    truncated = true;
  }
  return { text, truncated, totalLines };
}

export function clipCodeUnits(value: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  const last = value.charCodeAt(maxChars - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? maxChars - 1 : maxChars;
  return value.slice(0, end);
}
