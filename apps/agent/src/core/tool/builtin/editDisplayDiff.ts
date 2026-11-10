/** Edit 展示 diff：从完整文件前后文本生成有界、带上下文的多 hunk；不读写文件。 */
import type {
  EditDiffDisplay,
  EditDiffHunk,
  EditDiffLine,
  EditDiffLineKind,
} from "@answra/shared/schema";

const CONTEXT_LINES = 3;
const MAX_HUNKS = 20;
const MAX_DIFF_ROWS = 600;
const MAX_DIFF_CHARS = 20_000;
const MAX_LINE_CHARS = 2_000;
const MAX_LCS_CELLS = 400_000;

interface DiffRow {
  readonly kind: EditDiffLineKind;
  readonly text: string;
}

interface PositionedRow extends DiffRow {
  readonly oldCursor: number;
  readonly newCursor: number;
}

interface DiffRange {
  start: number;
  end: number;
}

interface MiddleDiff {
  readonly rows: readonly DiffRow[];
  readonly truncated: boolean;
}

export function buildEditDisplayDiff(before: string, after: string): EditDiffDisplay {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  const prefix = commonPrefixLength(oldLines, newLines);
  const suffix = commonSuffixLength(oldLines, newLines, prefix);
  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix);
  const newMiddle = newLines.slice(prefix, newLines.length - suffix);
  const middle = diffMiddle(oldMiddle, newMiddle);
  const positioned = positionRows(middle.rows, prefix + 1);
  const additions = countKind(middle.rows, "added");
  const deletions = countKind(middle.rows, "removed");
  const totalRows = prefix + positioned.length + suffix;
  const ranges = changeRanges(positioned, prefix, totalRows);
  const result = buildHunks({
    additions,
    deletions,
    middle: positioned,
    oldLines,
    newLines,
    prefix,
    suffix,
    ranges,
  });

  return { ...result, truncated: middle.truncated || result.truncated };
}

function buildHunks(input: {
  readonly additions: number;
  readonly deletions: number;
  readonly middle: readonly PositionedRow[];
  readonly oldLines: readonly string[];
  readonly newLines: readonly string[];
  readonly prefix: number;
  readonly suffix: number;
  readonly ranges: readonly DiffRange[];
}): EditDiffDisplay {
  const hunks: EditDiffHunk[] = [];
  let rows = 0;
  let chars = 0;
  let truncated = false;

  for (let rangeIndex = 0; rangeIndex < input.ranges.length; rangeIndex += 1) {
    const range = input.ranges[rangeIndex];
    if (!range) break;
    if (hunks.length >= MAX_HUNKS) {
      truncated = true;
      break;
    }

    const lines: EditDiffLine[] = [];
    let oldLines = 0;
    let newLines = 0;
    let oldStart: number | undefined;
    let newStart: number | undefined;

    for (let index = range.start; index < range.end; index += 1) {
      const row = rowAt(index, input);
      const text = clipLine(row.text);
      if (text.truncated) truncated = true;
      if (rows >= MAX_DIFF_ROWS || chars + text.text.length > MAX_DIFF_CHARS) {
        truncated = true;
        break;
      }

      oldStart ??= row.oldCursor;
      newStart ??= row.newCursor;
      lines.push({ kind: row.kind, text: text.text });
      rows += 1;
      chars += text.text.length;
      if (row.kind !== "added") oldLines += 1;
      if (row.kind !== "removed") newLines += 1;
    }

    if (lines.length > 0 && oldStart !== undefined && newStart !== undefined) {
      hunks.push({ oldStart, oldLines, newStart, newLines, lines });
    }
    if (rows >= MAX_DIFF_ROWS || chars >= MAX_DIFF_CHARS) {
      if (rangeIndex < input.ranges.length - 1) truncated = true;
      break;
    }
  }

  return {
    hunks,
    additions: input.additions,
    deletions: input.deletions,
    truncated,
  };
}

function rowAt(
  index: number,
  input: {
    readonly middle: readonly PositionedRow[];
    readonly oldLines: readonly string[];
    readonly newLines: readonly string[];
    readonly prefix: number;
    readonly suffix: number;
  },
): PositionedRow {
  if (index < input.prefix) {
    const line = index + 1;
    return contextRow(input.oldLines[index] ?? "", line, line);
  }

  const middleIndex = index - input.prefix;
  const middle = input.middle[middleIndex];
  if (middle) return middle;

  const suffixIndex = index - input.prefix - input.middle.length;
  const oldLine = input.oldLines.length - input.suffix + suffixIndex + 1;
  const newLine = input.newLines.length - input.suffix + suffixIndex + 1;
  return contextRow(input.oldLines[oldLine - 1] ?? "", oldLine, newLine);
}

function contextRow(text: string, oldLine: number, newLine: number): PositionedRow {
  return { kind: "context", text, oldCursor: oldLine, newCursor: newLine };
}

function changeRanges(
  rows: readonly PositionedRow[],
  prefix: number,
  totalRows: number,
): DiffRange[] {
  const ranges: DiffRange[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index]?.kind === "context") continue;
    const start = Math.max(0, prefix + index - CONTEXT_LINES);
    const end = Math.min(totalRows, prefix + index + 1 + CONTEXT_LINES);
    const previous = ranges[ranges.length - 1];
    if (previous && start <= previous.end) {
      previous.end = Math.max(previous.end, end);
    } else {
      ranges.push({ start, end });
    }
  }
  return ranges;
}

function positionRows(rows: readonly DiffRow[], startLine: number): PositionedRow[] {
  let oldCursor = startLine;
  let newCursor = startLine;
  return rows.map((row) => {
    const positioned: PositionedRow = { ...row, oldCursor, newCursor };
    if (row.kind !== "added") oldCursor += 1;
    if (row.kind !== "removed") newCursor += 1;
    return positioned;
  });
}

function diffMiddle(oldLines: readonly string[], newLines: readonly string[]): MiddleDiff {
  if (oldLines.length === 0) {
    return { rows: newLines.map((text) => ({ kind: "added", text })), truncated: false };
  }
  if (newLines.length === 0) {
    return { rows: oldLines.map((text) => ({ kind: "removed", text })), truncated: false };
  }
  if (oldLines.length * newLines.length > MAX_LCS_CELLS) {
    return {
      rows: [
        ...oldLines.map((text) => ({ kind: "removed" as const, text })),
        ...newLines.map((text) => ({ kind: "added" as const, text })),
      ],
      truncated: true,
    };
  }

  const widths = newLines.length + 1;
  const table = new Uint32Array((oldLines.length + 1) * widths);
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
  return { rows, truncated: false };
}

function commonPrefixLength(oldLines: readonly string[], newLines: readonly string[]): number {
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  return prefix;
}

function commonSuffixLength(
  oldLines: readonly string[],
  newLines: readonly string[],
  prefix: number,
): number {
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return suffix;
}

function countKind(rows: readonly DiffRow[], kind: EditDiffLineKind): number {
  return rows.reduce((count, row) => count + (row.kind === kind ? 1 : 0), 0);
}

function clipLine(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_LINE_CHARS) return { text, truncated: false };
  return { text: `${text.slice(0, MAX_LINE_CHARS)}…`, truncated: true };
}

function splitLines(value: string): string[] {
  const normalized = value.replaceAll("\r\n", "\n");
  return normalized.length === 0 ? [] : normalized.split("\n");
}
