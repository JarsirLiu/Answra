/** Pure line preview helpers for tool details; no Ink or React. */

export interface TextPreview {
  readonly text: string;
  readonly hidden: number;
  readonly truncated: boolean;
}

export function headPreview(text: string, limit: number): TextPreview {
  return preview(text, limit, false);
}

export function tailPreview(text: string, limit: number): TextPreview {
  return preview(text, limit, true);
}

export function formatHiddenLines(hidden: number): string | undefined {
  if (hidden <= 0) return undefined;
  return `… +${hidden} ${hidden === 1 ? "line" : "lines"}`;
}

export function formatTruncated(): string {
  return "… truncated";
}

function preview(text: string, limit: number, tail: boolean): TextPreview {
  const lines = text.split("\n");
  if (lines.length <= limit) return { text, hidden: 0, truncated: false };
  const shown = tail ? lines.slice(-limit) : lines.slice(0, limit);
  return { text: shown.join("\n"), hidden: lines.length - limit, truncated: true };
}
