/**
 * 建立 `session_items` 并回填历史消息；旧六张表保留到 P4 再删。
 *
 * `up` 只负责 DDL；回填细节在 `../sessionItemsBackfill/`，两者发布后均冻结。
 * 之所以不复用运行时适配器：已发布迁移必须冻结，运行时 SQL 或 schema 变化
 * 都不能改变一条旧库的迁移结果。
 */
import { checksumSql } from "../checksum";
import { backfillSessionItems } from "../sessionItemsBackfill/sessionItemsBackfill";
import type { Migration } from "../types";

const DDL = `
ALTER TABLE sessions ADD COLUMN next_seq INTEGER NOT NULL DEFAULT 1;

ALTER TABLE sessions ADD COLUMN open_turn_id TEXT;

CREATE TABLE session_items (
  conversation_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq > 0),
  item_id TEXT NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN ('user','text','reasoning','tool-call','tool-result','turn-end')),
  status TEXT NOT NULL
    CHECK (status IN ('complete','interrupted','failed')),
  turn_id TEXT,
  message_id TEXT,
  author_agent_id TEXT,
  audience_agent_id TEXT,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (conversation_id, seq),
  UNIQUE (conversation_id, item_id),
  CHECK (
    (kind IN ('user','turn-end') AND message_id IS NULL)
    OR (kind NOT IN ('user','turn-end') AND message_id IS NOT NULL)
  ),
  CHECK (kind <> 'turn-end' OR turn_id IS NOT NULL),
  FOREIGN KEY (conversation_id) REFERENCES sessions(conversation_id) ON DELETE CASCADE
);
`;

const BACKFILL_VERSION = "session-items-backfill-v1";

export const migration: Migration = {
  id: "20261123120000_session_items",
  checksum: checksumSql(`${DDL}\n${BACKFILL_VERSION}`),
  up(db) {
    db.exec(DDL);
    backfillSessionItems(db);
  },
};
