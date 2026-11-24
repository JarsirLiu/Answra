/** GFM 表格的解析与终端布局：列宽分配、单元格折行与过窄时的竖排降级；不依赖 Ink。 */
import stringWidth from "string-width";

export type TableAlign = "left" | "center" | "right";

export interface MarkdownTable {
  readonly header: readonly string[];
  readonly align: readonly TableAlign[];
  readonly rows: readonly (readonly string[])[];
}

/** 与 Claude Code 的 MarkdownTable 对齐：给父级缩进与终端宽度竞态留余量。 */
export const TABLE_SAFETY_MARGIN = 4;

export const TABLE_MIN_COLUMN_WIDTH = 3;
export const TABLE_MIN_WIDTH = 8;

const TABLE_MAX_CELL_LINES = 4;
const TABLE_CELL_PADDING = 2;
const TABLE_CELL_BORDER = 1;
const TABLE_FRAME_BORDER = 1;
const VERTICAL_SEPARATOR_MAX = 40;
const VERTICAL_WRAP_INDENT = 2;

/** 从 `lines[index]` 起的 GFM 表格；不是表格时返回 undefined，不吞并后续普通行。 */
export function parseTableAt(
  lines: readonly string[],
  index: number,
): { table: MarkdownTable; nextIndex: number } | undefined {
  const headerLine = lines[index];
  const delimiterLine = lines[index + 1];
  if (headerLine === undefined || delimiterLine === undefined) return undefined;
  if (!headerLine.includes("|")) return undefined;

  const header = splitTableRow(headerLine);
  const delimiter = splitTableRow(delimiterLine);
  if (header === undefined || delimiter === undefined) return undefined;
  if (header.length === 0 || header.length !== delimiter.length) return undefined;
  if (!delimiter.every(isDelimiterCell)) return undefined;

  const rows: string[][] = [];
  let nextIndex = index + 2;
  while (nextIndex < lines.length) {
    const line = lines[nextIndex];
    if (line === undefined || line.trim() === "" || !line.includes("|")) break;
    const cells = splitTableRow(line);
    if (cells === undefined) break;
    rows.push(normalizeCells(cells, header.length));
    nextIndex += 1;
  }

  return {
    table: {
      header: header.map(stripInlineMarkdown),
      align: delimiter.map(alignmentOf),
      rows: rows.map((row) => row.map(stripInlineMarkdown)),
    },
    nextIndex,
  };
}

/** 按终端显示宽度输出完整表格行；无法容纳最小列宽时降级为竖排键值。 */
export function layoutMarkdownTable(table: MarkdownTable, maxWidth: number): string[] {
  const columnCount = table.header.length;
  if (columnCount === 0) return [];

  const widths = allocateColumnWidths(table, maxWidth);
  if (widths === undefined) return layoutVertical(table, maxWidth);

  const headerLines = wrapRow(table.header, widths);
  const bodyLines = table.rows.map((row) => wrapRow(row, widths));
  const maxCellLines = Math.max(
    1,
    ...headerLines.map((lines) => lines.length),
    ...bodyLines.flatMap((cells) => cells.map((lines) => lines.length)),
  );
  if (maxCellLines > TABLE_MAX_CELL_LINES) return layoutVertical(table, maxWidth);

  const lines = [
    borderLine(widths, "top"),
    ...renderRow(headerLines, widths, table.align, true),
    borderLine(widths, "middle"),
  ];
  if (table.rows.length === 0) return [...lines, borderLine(widths, "bottom")];
  table.rows.forEach((_row, index) => {
    const cells = bodyLines[index] ?? [];
    lines.push(...renderRow(cells, widths, table.align, false));
    if (index < table.rows.length - 1) lines.push(borderLine(widths, "middle"));
  });
  lines.push(borderLine(widths, "bottom"));
  return lines;
}

function splitTableRow(line: string): string[] | undefined {
  const trimmed = line.trim();
  const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells = inner.split(/(?<!\\)\|/);
  if (cells.length === 0) return undefined;
  return cells.map((cell) => cell.replace(/\\\|/g, "|").trim());
}

function isDelimiterCell(cell: string): boolean {
  return /^:?-+:?$/.test(cell);
}

function alignmentOf(cell: string): TableAlign {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  return right ? "right" : "left";
}

function normalizeCells(cells: readonly string[], columnCount: number): string[] {
  return Array.from({ length: columnCount }, (_value, index) => cells[index] ?? "");
}

/** 表格单元格不承载行内样式，只保留可读文本；避免在折行后留下半截标记。 */
function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1");
}

function allocateColumnWidths(table: MarkdownTable, maxWidth: number): number[] | undefined {
  const columnCount = table.header.length;
  const minimums: number[] = [];
  const ideals: number[] = [];
  for (let column = 0; column < columnCount; column += 1) {
    let minimum = TABLE_MIN_COLUMN_WIDTH;
    let ideal = TABLE_MIN_COLUMN_WIDTH;
    for (const row of [table.header, ...table.rows]) {
      const text = row[column] ?? "";
      minimum = Math.max(minimum, longestBreakableWordWidth(text));
      ideal = Math.max(ideal, stringWidth(text));
    }
    minimums.push(minimum);
    ideals.push(ideal);
  }

  const borderWidth = TABLE_FRAME_BORDER + columnCount * (TABLE_CELL_PADDING + TABLE_CELL_BORDER);
  const available = Math.max(
    columnCount * TABLE_MIN_COLUMN_WIDTH,
    Math.floor(maxWidth) - borderWidth,
  );
  const totalIdeal = sum(ideals);
  const totalMinimum = sum(minimums);
  if (totalIdeal <= available) return ideals;
  if (totalMinimum > available) return undefined;

  const extraSpace = available - totalMinimum;
  const overflows = ideals.map((ideal, column) => ideal - (minimums[column] ?? 0));
  const totalOverflow = sum(overflows);
  if (totalOverflow === 0) return minimums;
  const widths = minimums.map(
    (minimum, column) =>
      minimum + Math.floor(((overflows[column] ?? 0) / totalOverflow) * extraSpace),
  );
  let remainder = available - sum(widths);
  for (let column = 0; remainder > 0; column = (column + 1) % columnCount) {
    widths[column] = (widths[column] ?? TABLE_MIN_COLUMN_WIDTH) + 1;
    remainder -= 1;
  }
  return widths;
}

/** CJK 与空格都可以断行；只有连续的西文单词才需要作为最小列宽保留。 */
function longestBreakableWordWidth(text: string): number {
  const segments = text.split(
    /[\s\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]+/,
  );
  return Math.max(TABLE_MIN_COLUMN_WIDTH, ...segments.map((segment) => stringWidth(segment)));
}

function wrapRow(row: readonly string[], widths: readonly number[]): string[][] {
  return widths.map((width, column) => wrapCell(row[column] ?? "", width));
}

function wrapCell(text: string, width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const lines: string[] = [];
  let line = "";
  let lineWidth = 0;
  for (const char of Array.from(text)) {
    const charWidth = stringWidth(char);
    if (lineWidth + charWidth > safeWidth && line.length > 0) {
      const breakAt = line.lastIndexOf(" ");
      if (breakAt > 0) {
        const rest = line.slice(breakAt + 1);
        lines.push(line.slice(0, breakAt));
        line = rest;
        lineWidth = stringWidth(rest);
      } else {
        lines.push(line);
        line = "";
        lineWidth = 0;
      }
    }
    line += char;
    lineWidth += charWidth;
  }
  lines.push(line);
  return lines.map((lineText) => lineText.trimEnd());
}

function renderRow(
  cellLines: readonly (readonly string[])[],
  widths: readonly number[],
  align: readonly TableAlign[],
  isHeader: boolean,
): string[] {
  const height = Math.max(1, ...cellLines.map((lines) => lines.length));
  const rendered: string[] = [];
  for (let lineIndex = 0; lineIndex < height; lineIndex += 1) {
    let line = "│";
    widths.forEach((width, column) => {
      const text = cellLines[column]?.[lineIndex] ?? "";
      const columnAlign = isHeader ? "center" : (align[column] ?? "left");
      line += ` ${padAligned(text, width, columnAlign)} │`;
    });
    rendered.push(line);
  }
  return rendered;
}

function borderLine(widths: readonly number[], kind: "top" | "middle" | "bottom"): string {
  const [left, middle, cross, right] =
    kind === "top"
      ? ["┌", "─", "┬", "┐"]
      : kind === "middle"
        ? ["├", "─", "┼", "┤"]
        : ["└", "─", "┴", "┘"];
  let line = left;
  widths.forEach((width, column) => {
    line += middle.repeat(width + TABLE_CELL_PADDING);
    line += column === widths.length - 1 ? right : cross;
  });
  return line;
}

function padAligned(text: string, width: number, align: TableAlign): string {
  const padding = Math.max(0, width - stringWidth(text));
  if (align === "right") return `${" ".repeat(padding)}${text}`;
  if (align === "center") {
    const left = Math.floor(padding / 2);
    return `${" ".repeat(left)}${text}${" ".repeat(padding - left)}`;
  }
  return `${text}${" ".repeat(padding)}`;
}

function layoutVertical(table: MarkdownTable, maxWidth: number): string[] {
  const width = Math.max(TABLE_MIN_WIDTH, Math.floor(maxWidth));
  const separatorWidth = Math.min(width, VERTICAL_SEPARATOR_MAX);
  const lines: string[] = [];
  table.rows.forEach((row, rowIndex) => {
    if (rowIndex > 0) lines.push("─".repeat(separatorWidth));
    row.forEach((value, column) => {
      const label = table.header[column] ?? `Column ${column + 1}`;
      const labelWidth = stringWidth(label) + 2;
      const firstWidth = Math.max(TABLE_MIN_WIDTH, width - labelWidth);
      const continuationWidth = Math.max(TABLE_MIN_WIDTH, width - VERTICAL_WRAP_INDENT);
      const firstLines = wrapCell(value, firstWidth);
      const remainder = firstLines
        .slice(1)
        .map((line) => line.trim())
        .join(" ");
      const continuation = remainder === "" ? [] : wrapCell(remainder, continuationWidth);
      lines.push(`${label}: ${firstLines[0] ?? ""}`.trimEnd());
      for (const line of continuation) {
        lines.push(`${" ".repeat(VERTICAL_WRAP_INDENT)}${line}`);
      }
    });
  });
  return lines;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
