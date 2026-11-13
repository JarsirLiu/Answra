/** 终端输入布局：按 grapheme 和显示宽度换行，输出光标、行偏移与可视窗口；不依赖 Ink/React。 */
import stringWidth from "string-width";

export interface InputToken {
  readonly text: string;
  readonly width: number;
  readonly offset: number;
}

export interface InputLine {
  readonly tokens: readonly InputToken[];
  readonly width: number;
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface InputLayout {
  readonly lines: readonly InputLine[];
  readonly cursorLine: number;
  readonly cursorColumn: number;
  readonly startLine: number;
  readonly visibleLineCount: number;
  readonly hiddenAbove: number;
  readonly hiddenBelow: number;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function previousGraphemeOffset(value: string, cursor: number): number {
  let previous = 0;
  for (const segment of graphemeSegmenter.segment(value)) {
    if (segment.index >= cursor) break;
    previous = segment.index;
  }
  return previous;
}

export function nextGraphemeOffset(value: string, cursor: number): number {
  for (const segment of graphemeSegmenter.segment(value)) {
    if (segment.index > cursor) return segment.index;
  }
  return value.length;
}

export function previousWordOffset(value: string, cursor: number): number {
  const before = value.slice(0, cursor);
  const match = before.match(/\s*\S+$/);
  return match === null ? 0 : cursor - match[0].length;
}

/** 多行输入中按显示行上下移动光标；目标行不存在时返回 undefined，调用方回退到历史浏览。 */
export function moveCursorVertically(
  value: string,
  cursor: number,
  columns: number,
  direction: -1 | 1,
): number | undefined {
  const measured = measureInput(value, cursor, columns);
  const targetLine = measured.cursorLine + direction;
  const line = measured.lines[targetLine];
  if (line === undefined) return undefined;
  return offsetAtColumn(line, measured.cursorColumn);
}

/** Home 语义：已在行首时退到上一显示行行首，与 Claude Code 一致。 */
export function startOfLineOffset(value: string, cursor: number, columns: number): number {
  const measured = measureInput(value, cursor, columns);
  const line = measured.lines[measured.cursorLine];
  if (line === undefined) return 0;
  if (measured.cursorColumn === 0 && measured.cursorLine > 0) {
    return measured.lines[measured.cursorLine - 1]?.startOffset ?? 0;
  }
  return line.startOffset;
}

/** End 语义：当前显示行的视觉行尾。 */
export function endOfLineOffset(value: string, cursor: number, columns: number): number {
  const measured = measureInput(value, cursor, columns);
  return measured.lines[measured.cursorLine]?.endOffset ?? value.length;
}

export function layoutInput(
  value: string,
  cursor: number,
  columns: number,
  maxVisibleLines: number,
): InputLayout {
  const safeVisibleLines = Math.max(1, Math.floor(maxVisibleLines));
  const { lines, cursorLine, cursorColumn } = measureInput(value, cursor, columns);
  const startLine = Math.max(0, Math.min(cursorLine, Math.max(0, lines.length - safeVisibleLines)));
  return {
    lines,
    cursorLine,
    cursorColumn,
    startLine,
    visibleLineCount: Math.min(safeVisibleLines, lines.length),
    hiddenAbove: startLine,
    hiddenBelow: Math.max(0, lines.length - startLine - safeVisibleLines),
  };
}

interface MeasuredInput {
  readonly lines: readonly InputLine[];
  readonly cursorLine: number;
  readonly cursorColumn: number;
}

function measureInput(value: string, cursor: number, columns: number): MeasuredInput {
  const safeColumns = Math.max(1, Math.floor(columns));
  const safeCursor = Math.max(0, Math.min(value.length, cursor));
  const lines: InputLine[] = [];
  let tokens: InputToken[] = [];
  let lineWidth = 0;
  let lineStartOffset = 0;
  let cursorLine = 0;
  let cursorColumn = 0;
  let cursorFound = false;
  let currentOffset = 0;

  const recordCursor = (line: number, column: number): void => {
    if (cursorFound || safeCursor > currentOffset) return;
    cursorLine = line;
    cursorColumn = column;
    cursorFound = true;
  };

  const pushLine = (endOffset: number): void => {
    lines.push({ tokens, width: lineWidth, startOffset: lineStartOffset, endOffset });
    tokens = [];
    lineWidth = 0;
  };

  for (const segment of graphemeSegmenter.segment(value)) {
    currentOffset = segment.index;
    const text = segment.segment;
    if (text === "\n") {
      recordCursor(lines.length, lineWidth);
      pushLine(currentOffset);
      lineStartOffset = currentOffset + 1;
      continue;
    }
    const width = stringWidth(text);
    if (lineWidth > 0 && lineWidth + width > safeColumns) {
      pushLine(currentOffset);
      lineStartOffset = currentOffset;
      recordCursor(lines.length, 0);
    } else {
      recordCursor(lines.length, lineWidth);
    }
    tokens.push({ text, width, offset: currentOffset });
    lineWidth += width;
  }

  if (!cursorFound) {
    cursorLine = lines.length;
    cursorColumn = lineWidth;
  }
  pushLine(value.length);
  return { lines, cursorLine, cursorColumn };
}

function offsetAtColumn(line: InputLine, column: number): number {
  let width = 0;
  for (const token of line.tokens) {
    if (width + token.width > column) return token.offset;
    width += token.width;
  }
  return line.endOffset;
}
