/** 内存消息 snapshot 到分页结果的纯投影；不读数据库、不编码游标。 */
import type { ConversationMessage } from "@answra/shared";
import type { ConversationMessagePage } from "../../catalog";

export function selectMessagePage({
  messages,
  sequenceById,
  cursorSeq,
  limit,
}: {
  messages: readonly ConversationMessage[];
  sequenceById: ReadonlyMap<string, number> | undefined;
  cursorSeq?: number;
  limit: number;
}): ConversationMessagePage & { oldestSeq?: number } {
  const entries = messages.map((message, index) => ({
    message,
    seq: sequenceById?.get(message.id) ?? index + 1,
  }));
  const candidates =
    cursorSeq === undefined ? entries : entries.filter((entry) => entry.seq < cursorSeq);
  const start = Math.max(0, candidates.length - limit - 1);
  const tail = candidates.slice(start);
  const hasMore = tail.length > limit;
  const page = hasMore ? tail.slice(tail.length - limit) : tail;
  return {
    items: page.map((entry) => entry.message),
    ...(hasMore && page[0] !== undefined ? { oldestSeq: page[0].seq } : {}),
  };
}
