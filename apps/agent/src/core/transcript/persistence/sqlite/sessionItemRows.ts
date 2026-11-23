/** `session_items` 的行读写；只放 SQL 与列映射，不分配 seq、不判断 Turn 语义。 */
import type { DatabaseSync } from "node:sqlite";
import type { SessionItem } from "@answra/shared/schema";
import {
  fromSessionItemColumns,
  type SessionItemColumns,
  toSessionItemColumns,
} from "./sessionItemMap";

/** 会话行上由条目写入维护的三个字段；`message_count` 与正文写入同事务。 */
export interface SessionItemState {
  nextSeq: number;
  openTurnId?: string;
  messageCount: number;
}

export interface ListSessionItemOptions {
  /** 只读该 seq 之后的条目；缺省从 1 开始。 */
  afterSeq?: number;
  /** 正数限制条数；缺省读取全部。 */
  limit?: number;
}

const INSERT_ITEM_SQL = `
  INSERT INTO session_items
    (conversation_id, seq, item_id, kind, status, turn_id, message_id,
     author_agent_id, audience_agent_id, created_at, payload_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(conversation_id, item_id) DO NOTHING
`;

const LIST_ITEMS_SQL = `
  SELECT seq, item_id, kind, status, turn_id, message_id,
         author_agent_id, audience_agent_id, created_at, payload_json
  FROM session_items
  WHERE conversation_id = ? AND seq > ?
  ORDER BY seq ASC
  LIMIT ?
`;

const READ_STATE_SQL = `
  SELECT next_seq, open_turn_id, message_count
  FROM sessions
  WHERE conversation_id = ?
`;

/** 派生 `item_id` 命中唯一约束时返回 false；调用方据此决定是否推进 `next_seq`。 */
export function insertSessionItemRow(
  db: DatabaseSync,
  conversationId: string,
  item: SessionItem,
): boolean {
  const columns = toSessionItemColumns(item);
  const result = db
    .prepare(INSERT_ITEM_SQL)
    .run(
      conversationId,
      columns.seq,
      columns.item_id,
      columns.kind,
      columns.status,
      columns.turn_id,
      columns.message_id,
      columns.author_agent_id,
      columns.audience_agent_id,
      columns.created_at,
      columns.payload_json,
    );
  return Number(result.changes) === 1;
}

export function listSessionItemRows(
  db: DatabaseSync,
  conversationId: string,
  options: ListSessionItemOptions = {},
): SessionItem[] {
  const rows = db
    .prepare(LIST_ITEMS_SQL)
    .all(
      conversationId,
      options.afterSeq ?? 0,
      options.limit ?? -1,
    ) as unknown as SessionItemColumns[];
  return rows.map(fromSessionItemColumns);
}

export function readSessionItemState(
  db: DatabaseSync,
  conversationId: string,
): SessionItemState | undefined {
  const row = db.prepare(READ_STATE_SQL).get(conversationId) as
    | { next_seq: number; open_turn_id: string | null; message_count: number }
    | undefined;
  if (row === undefined) return undefined;
  return {
    nextSeq: row.next_seq,
    ...(row.open_turn_id === null ? {} : { openTurnId: row.open_turn_id }),
    messageCount: row.message_count,
  };
}

const MESSAGE_EXISTS_SQL = `
  SELECT 1 FROM session_items
  WHERE conversation_id = ?
    AND (message_id = ? OR (message_id IS NULL AND item_id = ?))
  LIMIT 1
`;

const WRITE_STATE_SQL = `
  UPDATE sessions
  SET next_seq = ?, message_count = ?, open_turn_id = ?,
      updated_at = COALESCE(?, updated_at)
  WHERE conversation_id = ?
`;

const OPEN_TURN_SQL = `
  UPDATE sessions
  SET open_turn_id = ?
  WHERE conversation_id = ?
`;

const CLOSE_TURN_SQL = `
  UPDATE sessions
  SET open_turn_id = NULL
  WHERE conversation_id = ? AND open_turn_id = ?
`;

const DELETE_ITEMS_SQL = "DELETE FROM session_items WHERE conversation_id = ?";

/** `message_count` 只在消息首次出现时 +1；插入前调用。 */
export function sessionItemMessageExists(
  db: DatabaseSync,
  conversationId: string,
  messageKey: string,
): boolean {
  return db.prepare(MESSAGE_EXISTS_SQL).get(conversationId, messageKey, messageKey) !== undefined;
}

export function writeSessionItemState(
  db: DatabaseSync,
  conversationId: string,
  state: SessionItemState,
  updatedAt?: string,
): void {
  db.prepare(WRITE_STATE_SQL).run(
    state.nextSeq,
    state.messageCount,
    state.openTurnId ?? null,
    updatedAt ?? null,
    conversationId,
  );
}

/** 无条件置位；Turn 开始时调用。 */
export function setSessionOpenTurn(db: DatabaseSync, conversationId: string, turnId: string): void {
  db.prepare(OPEN_TURN_SQL).run(turnId, conversationId);
}

/** 只在指针仍指向该 Turn 时清空，保证并发第二次收口是 no-op。 */
export function closeSessionOpenTurn(
  db: DatabaseSync,
  conversationId: string,
  turnId: string,
): void {
  db.prepare(CLOSE_TURN_SQL).run(conversationId, turnId);
}

export function deleteSessionItemRows(db: DatabaseSync, conversationId: string): void {
  db.prepare(DELETE_ITEMS_SQL).run(conversationId);
}
