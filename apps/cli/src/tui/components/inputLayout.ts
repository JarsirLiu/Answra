/** 终端输入布局：按 grapheme 和显示宽度换行，输出光标与可视窗口；不依赖 Ink/React。 */
import stringWidth from "string-width";

export interface InputToken {
  readonly text: string;
  readonly width: number;
}

export interface InputLine {
  readonly tokens: readonly InputToken[];
  readonly width: number;
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

export function layoutInput(
  value: string,
  cursor: number,
  columns: number,
  maxVisibleLines: number,
): InputLayout {
  const safeColumns = Math.max(1, Math.floor(columns));
  const safeVisibleLines = Math.max(1, Math.floor(maxVisibleLines));
  const safeCursor = Math.max(0, Math.min(value.length, cursor));

  const lines: InputLine[] = [];
  let tokens: InputToken[] = [];
  let lineWidth = 0;
  let cursorLine = 0;
  let cursorColumn = 0;
  let cursorFound = false;

  const recordCursor = (line: number, column: number): void => {
    if (cursorFound || safeCursor > currentOffset) return;
    cursorLine = line;
    cursorColumn = column;
    cursorFound = true;
  };

  const newLine = (): void => {
    lines.push({ tokens, width: lineWidth });
    tokens = [];
    lineWidth = 0;
  };

  let currentOffset = 0;
  for (const segment of graphemeSegmenter.segment(value)) {
    currentOffset = segment.index;
    const text = segment.segment;
    if (text === "\n") {
      recordCursor(lines.length, lineWidth);
      newLine();
      continue;
    }
    const width = stringWidth(text);
    if (lineWidth > 0 && lineWidth + width > safeColumns) {
      newLine();
    }
    recordCursor(lines.length, lineWidth);
    tokens.push({ text, width });
    lineWidth += width;
  }

  if (!cursorFound) {
    cursorLine = lines.length;
    cursorColumn = lineWidth;
  }
  lines.push({ tokens, width: lineWidth });

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
