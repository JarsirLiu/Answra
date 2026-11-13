/** 终端选区纯函数：屏幕坐标排序、按显示列截取文本与 ANSI 反色高亮；不依赖 Ink/React。 */
// biome-ignore-all lint/suspicious/noControlCharactersInRegex: ANSI escape sequences are this module's input domain.
import stringWidth from "string-width";

export interface SelectionPoint {
  readonly row: number;
  readonly col: number;
}

export interface SelectionBounds {
  readonly start: SelectionPoint;
  readonly end: SelectionPoint;
}

/** 已渲染的一行可见文本；row/left 均为 0-based 屏幕单元，text 不含 ANSI。 */
export interface RenderedLine {
  readonly row: number;
  readonly left: number;
  readonly text: string;
}

/** 选区在某一行上覆盖的相对显示列（含两端，0-based）。 */
export interface SelectionRowRange {
  readonly from: number;
  readonly to: number;
}

const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g;
const FULL_RESET_PATTERN = /^\x1b\[0?m$/;
const INVERSE_ON = "\x1b[7m";
const INVERSE_OFF = "\x1b[27m";
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

export function compareSelectionPoints(left: SelectionPoint, right: SelectionPoint): number {
  if (left.row !== right.row) return left.row < right.row ? -1 : 1;
  if (left.col !== right.col) return left.col < right.col ? -1 : 1;
  return 0;
}

/** 把 anchor/focus 归一成阅读顺序；两者相同时返回 undefined，单击不算选区。 */
export function orderSelection(
  anchor: SelectionPoint | undefined,
  focus: SelectionPoint | undefined,
): SelectionBounds | undefined {
  if (anchor === undefined || focus === undefined) return undefined;
  if (compareSelectionPoints(anchor, focus) === 0) return undefined;
  return compareSelectionPoints(anchor, focus) < 0
    ? { start: anchor, end: focus }
    : { start: focus, end: anchor };
}

/** 选区与已渲染行的交集；不在选区内的行返回 undefined。 */
export function selectionRowRange(
  bounds: SelectionBounds,
  line: RenderedLine,
): SelectionRowRange | undefined {
  if (line.row < bounds.start.row || line.row > bounds.end.row) return undefined;
  const width = stringWidth(line.text);
  if (width === 0) return undefined;
  const lineEnd = line.left + width - 1;
  const from = line.row === bounds.start.row ? bounds.start.col : line.left;
  const to = line.row === bounds.end.row ? bounds.end.col : lineEnd;
  const clampedFrom = Math.max(from, line.left);
  const clampedTo = Math.min(to, lineEnd);
  if (clampedFrom > clampedTo) return undefined;
  return { from: clampedFrom - line.left, to: clampedTo - line.left };
}

/**
 * 在选区范围内读取文本：首末行按显示列截取，中间行取整行；行尾空白去掉，
 * 首尾空行去掉后用 \n 连接。宽字符按 grapheme 起点吸附，不会复制半个字符。
 */
export function extractSelectionText(
  bounds: SelectionBounds,
  lines: ReadonlyMap<number, RenderedLine>,
): string {
  const selected: string[] = [];
  for (let row = bounds.start.row; row <= bounds.end.row; row += 1) {
    const line = lines.get(row);
    if (line === undefined) {
      selected.push("");
      continue;
    }
    const range = selectionRowRange(bounds, line);
    if (range === undefined) {
      selected.push("");
      continue;
    }
    selected.push(sliceByColumns(line.text, range.from, range.to).trimEnd());
  }
  while (selected.length > 0 && selected[0] === "") selected.shift();
  while (selected.length > 0 && selected[selected.length - 1] === "") selected.pop();
  return selected.join("\n");
}

/** 按显示列截取纯文本；起始列落在宽字符中间时从该 grapheme 起点开始。 */
export function sliceByColumns(text: string, from: number, to: number): string {
  if (to < from) return "";
  let result = "";
  let column = 0;
  for (const segment of graphemeSegmenter.segment(text)) {
    const width = stringWidth(segment.segment);
    const start = column;
    column += width;
    if (start > to) break;
    if (start >= from || start + width > from) result += segment.segment;
  }
  return result;
}

/**
 * 给选区覆盖的显示列插入反色；ANSI 颜色保留，行内 full reset 后重新打开反色。
 * from/to 是相对该行的显示列（含两端）。
 */
export function highlightSelection(text: string, from: number, to: number): string {
  if (to < from) return text;
  let result = "";
  let column = 0;
  let inverse = false;
  let cursor = 0;

  const openInverse = (): void => {
    if (inverse) return;
    result += INVERSE_ON;
    inverse = true;
  };
  const closeInverse = (): void => {
    if (!inverse) return;
    result += INVERSE_OFF;
    inverse = false;
  };
  const paintPlain = (chunk: string): void => {
    for (const segment of graphemeSegmenter.segment(chunk)) {
      const width = stringWidth(segment.segment);
      const start = column;
      column += width;
      const selected = start <= to && start + width - 1 >= from;
      if (selected) openInverse();
      else closeInverse();
      result += segment.segment;
    }
  };

  for (const match of text.matchAll(ANSI_PATTERN)) {
    const index = match.index ?? 0;
    paintPlain(text.slice(cursor, index));
    const sequence = match[0];
    result += sequence;
    if (inverse && FULL_RESET_PATTERN.test(sequence)) result += INVERSE_ON;
    cursor = index + sequence.length;
  }
  paintPlain(text.slice(cursor));
  closeInverse();
  return result;
}

/** 可见区全部已登记行：用于 Ctrl+Shift+A；没有已登记行时返回 undefined。 */
export function selectAllBounds(
  lines: ReadonlyMap<number, RenderedLine>,
): SelectionBounds | undefined {
  if (lines.size === 0) return undefined;
  let first: RenderedLine | undefined;
  let last: RenderedLine | undefined;
  for (const line of lines.values()) {
    if (first === undefined || line.row < first.row) first = line;
    if (last === undefined || line.row > last.row) last = line;
  }
  if (first === undefined || last === undefined) return undefined;
  const lastWidth = Math.max(1, stringWidth(last.text));
  return {
    start: { row: first.row, col: first.left },
    end: { row: last.row, col: last.left + lastWidth - 1 },
  };
}
