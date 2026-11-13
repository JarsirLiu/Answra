/** 虚拟 transcript 的纯布局计算：高度估算、前缀偏移和可视窗口；不依赖 Ink/React。 */
import type { ConversationViewMessage } from "@answra/ui/conversation-view";
import stringWidth from "string-width";

const MIN_MESSAGE_HEIGHT = 1;
const TOOL_HEADER_LINES = 2;
const TOOL_OUTPUT_LINES = 8;

export function estimateMessageHeight(
  message: ConversationViewMessage,
  columns: number,
  expandThinking: boolean,
): number {
  const width = Math.max(8, columns - 2);
  if (message.role === "user") return countTextLines(message.text, width) + 1;
  const parts = message.parts ?? [];
  if (parts.length === 0) return countTextLines(message.text, width) + 1;
  let height = 1;
  for (const part of parts) {
    if (part.kind === "text") {
      height += countTextLines(part.text, width);
      continue;
    }
    if (part.kind === "reasoning") {
      height += expandThinking ? countTextLines(part.text, width) + 1 : 1;
      continue;
    }
    height += estimateToolHeight(part, expandThinking);
  }
  return Math.max(MIN_MESSAGE_HEIGHT, height);
}

export function countTextLines(text: string, columns: number): number {
  if (text.length === 0) return 1;
  let total = 0;
  for (const line of text.split("\n")) {
    const width = stringWidth(line);
    total += Math.max(1, Math.ceil(width / Math.max(1, columns)));
  }
  return total;
}

export function buildOffsets(heights: readonly number[]): number[] {
  const offsets = [0];
  for (const height of heights) {
    const previous = offsets[offsets.length - 1] ?? 0;
    offsets.push(previous + Math.max(1, height));
  }
  return offsets;
}

export function messageMeasureKey(message: ConversationViewMessage): string {
  let key = `${message.text.length}:${message.parts?.length ?? 0}`;
  for (const part of message.parts ?? []) {
    if (part.kind === "tool") {
      const outputLength = typeof part.output === "string" ? part.output.length : 0;
      key += `|${part.kind}:${part.state}:${outputLength}:${part.errorText?.length ?? 0}`;
    } else {
      key += `|${part.kind}:${part.text.length}`;
    }
  }
  return key;
}

export interface VirtualWindow {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly offsetWithin: number;
}

export function findVirtualWindow(
  offsets: readonly number[],
  scrollTop: number,
  viewportHeight: number,
  overscan: number,
): VirtualWindow {
  const itemCount = Math.max(0, offsets.length - 1);
  if (itemCount === 0) return { startIndex: 0, endIndex: 0, offsetWithin: 0 };
  const totalHeight = offsets[itemCount] ?? 0;
  const maxScrollTop = Math.max(0, totalHeight - Math.max(1, viewportHeight));
  const clamped = Math.max(0, Math.min(scrollTop, maxScrollTop));
  const first = findIndexAtOrBefore(offsets, clamped);
  const startIndex = Math.max(0, first - 1);
  let endIndex = Math.max(
    startIndex + 1,
    findIndexAtOrBefore(offsets, clamped + viewportHeight) + 1,
  );
  if (endIndex > itemCount) endIndex = itemCount;
  const overscanEnd = clamped + viewportHeight + overscan;
  while (endIndex < itemCount && (offsets[endIndex] ?? overscanEnd) < overscanEnd) endIndex += 1;
  return { startIndex, endIndex, offsetWithin: clamped - (offsets[startIndex] ?? 0) };
}

export function maxScrollTop(totalHeight: number, viewportHeight: number): number {
  return Math.max(0, totalHeight - Math.max(1, viewportHeight));
}

function findIndexAtOrBefore(offsets: readonly number[], value: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((offsets[middle] ?? value) <= value) low = middle;
    else high = middle - 1;
  }
  return Math.min(low, Math.max(0, offsets.length - 2));
}

interface ToolPartShape {
  readonly output?: unknown;
  readonly errorText?: string;
}

function estimateToolHeight(part: ToolPartShape, expandThinking: boolean): number {
  let height = TOOL_HEADER_LINES;
  const output = formatToolOutput(part.output);
  if (output !== undefined) {
    const lines = output.split("\n").length;
    height += expandThinking ? Math.min(lines, 200) : Math.min(lines, TOOL_OUTPUT_LINES);
  }
  if (part.errorText !== undefined) height += 1;
  return height;
}

function formatToolOutput(output: unknown): string | undefined {
  if (output === undefined) return undefined;
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return "工具已返回结果";
  }
}
