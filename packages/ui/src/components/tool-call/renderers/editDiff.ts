/** Edit 展开视图的行级 diff：只处理模型提供的 old/new 片段，不读取文件。 */

export interface EditDiffLine {
  readonly kind: "context" | "removed" | "added";
  readonly oldLine?: number;
  readonly newLine?: number;
  readonly text: string;
}

export interface EditDiff {
  readonly lines: readonly EditDiffLine[];
  readonly additions: number;
  readonly deletions: number;
  readonly truncated: boolean;
}

const READ_LINE_PREFIX = /^(\d+)(?:\t|: )/;
const MAX_SOURCE_LINES = 600;
const MAX_DIFF_ROWS = 600;
const MAX_DP_CELLS = 400_000;

export function buildEditDiff(oldString: string, newString: string): EditDiff {
  const old = parseOldString(oldString);
  const newLines = splitLines(newString);
  const oldLines = old.lines.slice(0, MAX_SOURCE_LINES);
  const visibleNewLines = newLines.slice(0, MAX_SOURCE_LINES);
  const rows = diffLines(oldLines, visibleNewLines);
  const truncated =
    old.lines.length > MAX_SOURCE_LINES ||
    newLines.length > MAX_SOURCE_LINES ||
    rows.length > MAX_DIFF_ROWS;
  const lines: EditDiffLine[] = [];
  let oldLine = old.startLine;
  let newLine = old.startLine;

  for (const row of rows.slice(0, MAX_DIFF_ROWS)) {
    if (row.kind === "context") {
      lines.push({ kind: "context", oldLine, newLine, text: row.text });
      oldLine += 1;
      newLine += 1;
    } else if (row.kind === "removed") {
      lines.push({ kind: "removed", oldLine, text: row.text });
      oldLine += 1;
    } else {
      lines.push({ kind: "added", newLine, text: row.text });
      newLine += 1;
    }
  }

  return {
    lines,
    additions: rows.filter((row) => row.kind === "added").length,
    deletions: rows.filter((row) => row.kind === "removed").length,
    truncated,
  };
}

interface ParsedOldString {
  readonly lines: readonly string[];
  readonly startLine: number;
}

function parseOldString(value: string): ParsedOldString {
  const lines = splitLines(value);
  const prefixes = lines.map((line) => READ_LINE_PREFIX.exec(line));
  if (lines.length === 0 || !prefixes.every((prefix) => prefix !== null)) {
    return { lines, startLine: 1 };
  }
  const startLine = Number(prefixes[0]?.[1]);
  if (!Number.isFinite(startLine)) return { lines, startLine: 1 };
  return {
    lines: lines.map((line, index) => line.slice(prefixes[index]?.[0].length ?? 0)),
    startLine,
  };
}

function splitLines(value: string): string[] {
  const normalized = value.replaceAll("\r\n", "\n");
  return normalized.length === 0 ? [] : normalized.split("\n");
}

interface DiffRow {
  readonly kind: EditDiffLine["kind"];
  readonly text: string;
}

function diffLines(oldLines: readonly string[], newLines: readonly string[]): DiffRow[] {
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix);
  const newMiddle = newLines.slice(prefix, newLines.length - suffix);
  const rows: DiffRow[] = [];
  for (const text of oldLines.slice(0, prefix)) rows.push({ kind: "context", text });
  rows.push(...diffMiddle(oldMiddle, newMiddle));
  for (const text of oldLines.slice(oldLines.length - suffix)) {
    rows.push({ kind: "context", text });
  }
  return rows;
}

function diffMiddle(oldLines: readonly string[], newLines: readonly string[]): DiffRow[] {
  if (oldLines.length === 0) return newLines.map((text) => ({ kind: "added", text }));
  if (newLines.length === 0) return oldLines.map((text) => ({ kind: "removed", text }));

  if (oldLines.length * newLines.length > MAX_DP_CELLS) {
    return [
      ...oldLines.map((text) => ({ kind: "removed" as const, text })),
      ...newLines.map((text) => ({ kind: "added" as const, text })),
    ];
  }

  const widths = newLines.length + 1;
  const table = new Uint16Array((oldLines.length + 1) * widths);
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      table[oldIndex * widths + newIndex] =
        oldLines[oldIndex] === newLines[newIndex]
          ? (table[(oldIndex + 1) * widths + newIndex + 1] ?? 0) + 1
          : Math.max(
              table[(oldIndex + 1) * widths + newIndex] ?? 0,
              table[oldIndex * widths + newIndex + 1] ?? 0,
            );
    }
  }

  const rows: DiffRow[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      rows.push({ kind: "context", text: oldLines[oldIndex] ?? "" });
      oldIndex += 1;
      newIndex += 1;
    } else if (
      (table[(oldIndex + 1) * widths + newIndex] ?? 0) >=
      (table[oldIndex * widths + newIndex + 1] ?? 0)
    ) {
      rows.push({ kind: "removed", text: oldLines[oldIndex] ?? "" });
      oldIndex += 1;
    } else {
      rows.push({ kind: "added", text: newLines[newIndex] ?? "" });
      newIndex += 1;
    }
  }
  while (oldIndex < oldLines.length) {
    rows.push({ kind: "removed", text: oldLines[oldIndex] ?? "" });
    oldIndex += 1;
  }
  while (newIndex < newLines.length) {
    rows.push({ kind: "added", text: newLines[newIndex] ?? "" });
    newIndex += 1;
  }
  return rows;
}
