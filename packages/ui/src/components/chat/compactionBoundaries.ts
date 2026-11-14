/** 把压缩边界按 throughMessageId 锚定到对话消息之后；仅负责展示顺序。 */
import type { ContextCompactionBoundary } from "@answra/shared";
import type { ConversationViewMessage } from "./conversationMessage";

export type ChatTimelineItem =
  | { readonly kind: "message"; readonly id: string; readonly message: ConversationViewMessage }
  | {
      readonly kind: "compaction";
      readonly id: string;
      readonly boundary: ContextCompactionBoundary;
    };

export function mergeCompactionBoundaries(
  messages: readonly ConversationViewMessage[],
  boundaries: readonly ContextCompactionBoundary[] = [],
): ChatTimelineItem[] {
  const after = new Map<string, ContextCompactionBoundary[]>();
  for (const boundary of boundaries) {
    const anchored = after.get(boundary.throughMessageId);
    if (anchored === undefined) after.set(boundary.throughMessageId, [boundary]);
    else anchored.push(boundary);
  }

  const items: ChatTimelineItem[] = [];
  for (const message of messages) {
    items.push({ kind: "message", id: message.id, message });
    const anchored = after.get(message.id);
    if (anchored === undefined) continue;
    after.delete(message.id);
    for (const boundary of anchored) items.push(compactionItem(boundary));
  }
  for (const anchored of after.values()) {
    for (const boundary of anchored) items.push(compactionItem(boundary));
  }
  return items;
}

function compactionItem(boundary: ContextCompactionBoundary): ChatTimelineItem {
  return { kind: "compaction", id: boundary.id, boundary };
}
