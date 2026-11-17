/** 命令候选行的显示宽度计算：只做文本截断与补齐，不读取终端或组件状态。 */
import stringWidth from "string-width";

const ELLIPSIS = "…";
const MIN_USAGE_COLUMNS = 12;
const MAX_USAGE_RATIO = 0.4;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (stringWidth(text) <= maxWidth) return text;
  const limit = Math.max(0, maxWidth - stringWidth(ELLIPSIS));
  let result = "";
  let width = 0;
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const segmentWidth = stringWidth(segment);
    if (width + segmentWidth > limit) break;
    result += segment;
    width += segmentWidth;
  }
  return `${result}${ELLIPSIS}`;
}

export function padToWidth(text: string, width: number): string {
  return `${text}${" ".repeat(Math.max(0, width - stringWidth(text)))}`;
}

export function commandUsageColumn(usages: readonly string[], availableColumns: number): number {
  const longest = usages.reduce((max, usage) => Math.max(max, stringWidth(usage)), 0);
  const cap = Math.max(1, Math.floor(availableColumns * MAX_USAGE_RATIO));
  return Math.max(1, Math.min(cap, Math.max(MIN_USAGE_COLUMNS, longest + 2)));
}
