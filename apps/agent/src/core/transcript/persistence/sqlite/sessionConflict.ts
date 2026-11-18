/** 冲突败方清理：只删除未提交草稿，并把已提交 streaming 占位标记为 interrupted。 */
import type { DatabaseSync } from "node:sqlite";
import { parseStoredMessage } from "../sessionRecord";
import { deleteDraftRow, updateMessageRow } from "./sessionRows";

export function cleanupConflictOwnedMessages(
  db: DatabaseSync,
  conversationId: string,
  messageIds: ReadonlySet<string>,
): void {
  for (const messageId of messageIds) {
    deleteDraftRow(db, conversationId, messageId);
    interruptStreamingMessageRow(db, conversationId, messageId);
  }
}

function interruptStreamingMessageRow(
  db: DatabaseSync,
  conversationId: string,
  messageId: string,
): void {
  const row = db
    .prepare(`
      SELECT message_json
      FROM session_messages
      WHERE conversation_id = ? AND message_id = ? AND status = 'streaming'
    `)
    .get(conversationId, messageId) as { message_json: string } | undefined;
  if (!row) return;
  const message = parseStoredMessage(JSON.parse(row.message_json) as unknown);
  updateMessageRow(db, conversationId, { ...message, status: "interrupted" });
}
