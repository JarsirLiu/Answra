/** 虚拟 transcript 的纯布局计算：高度估算、前缀偏移和可视窗口；不依赖 Ink/React。 */
import type { ConversationMessagePart } from "@answra/shared";
import type { ConversationViewMessage } from "@answra/ui/conversation-view";
import { isToolRunning, presentToolCall } from "@answra/ui/tool-presentation";
import stringWidth from "string-width";
import { groupMessageParts, type ToolGroup } from "./tool/groups/groupToolCalls";
import {
  TOOL_EXPANDED_DIFF_LINES,
  TOOL_EXPANDED_TEXT_LINES,
  TOOL_PREVIEW_DIFF_LINES,
  TOOL_PREVIEW_TEXT_LINES,
  TOOL_RUNNING_TAIL_LINES,
} from "./tool/toolLayout";

const MIN_MESSAGE_HEIGHT = 1;
const TOOL_HEADER_LINES = 1;
const TOOL_RESULT_LINES = 1;

export function estimateMessageHeight(
  message: ConversationViewMessage,
  columns: number,
  expandThinking: boolean,
  expandedToolIds?: ReadonlySet<string>,
): number {
  const width = Math.max(8, columns - 2);
  if (message.role === "user") return countTextLines(message.text, width) + 1;
  const parts = message.parts ?? [];
  if (parts.length === 0) return countTextLines(message.text, width) + 1;
  let height = 1;
  for (const part of groupMessageParts(parts)) {
    if (part.kind === "tool-group") {
      height += estimateToolGroupHeight(
        part,
        width,
        expandThinking || expandedToolIds?.has(part.id) === true,
      );
      continue;
    }
    if (part.kind === "text") {
      height += countTextLines(part.text, width);
      continue;
    }
    if (part.kind === "reasoning") {
      height += expandThinking ? countTextLines(part.text, width) + 1 : 1;
      continue;
    }
    height += estimateToolHeight(
      part,
      width,
      expandThinking || expandedToolIds?.has(part.id) === true,
    );
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

type ToolPartShape = Extract<ConversationMessagePart, { kind: "tool" }>;

function estimateToolGroupHeight(group: ToolGroup, width: number, expanded: boolean): number {
  if (!expanded) return TOOL_HEADER_LINES;
  let height = TOOL_HEADER_LINES;
  for (const part of group.parts) height += estimateToolHeight(part, width, true);
  return height;
}

function estimateToolHeight(part: ToolPartShape, width: number, expanded: boolean): number {
  const presentation = presentToolCall({
    toolName: part.toolName,
    state: part.state,
    input: part.input,
    inputText: part.inputText,
    output: part.output,
    errorText: part.errorText,
    title: part.title,
  });
  let height = TOOL_HEADER_LINES;
  if (
    presentation.resultLine !== undefined ||
    presentation.errorText !== undefined ||
    (presentation.expandable && !expanded)
  ) {
    height += TOOL_RESULT_LINES;
  }
  if (presentation.details.length === 0) return height;
  if (!expanded && presentation.category === "search") return height;

  for (const detail of presentation.details) {
    if (detail.kind === "text") {
      const runningTail = isToolRunning(presentation.state) && presentation.category === "command";
      const limit = expanded
        ? TOOL_EXPANDED_TEXT_LINES
        : runningTail
          ? TOOL_RUNNING_TAIL_LINES
          : TOOL_PREVIEW_TEXT_LINES;
      const lineCount = detail.text.split("\n").length;
      height += Math.min(limit, countTextLines(detail.text, width));
      if (detail.label !== undefined) height += 1;
      if (lineCount > limit || detail.truncated) height += 1;
      continue;
    }
    if (detail.kind === "diff") {
      const lines = detail.diff.hunks.reduce((total, hunk) => total + 1 + hunk.lines.length, 0);
      const limit = expanded ? TOOL_EXPANDED_DIFF_LINES : TOOL_PREVIEW_DIFF_LINES;
      height += Math.min(limit, lines);
      if (lines > limit || detail.diff.truncated) height += 1;
      continue;
    }
    height += 1;
  }
  return height;
}
