/**
 * P4：删除被 `session_items` 取代的旧表与 `sessions.revision`，库内只剩 `sessions` 与
 * `session_items` 两张业务表。
 *
 * 只做 DDL：数据搬运已在 P1 完成，这里不再读写旧表内容。删表前先删级联 trigger，
 * 避免留下指向已删除表的悬空 trigger。
 */
import { checksumSql } from "../checksum";
import type { Migration } from "../types";

const DDL = `
DROP TRIGGER IF EXISTS sessions_delete_session_turns;

DROP TRIGGER IF EXISTS sessions_delete_session_events;

DROP TABLE IF EXISTS session_events;

DROP TABLE IF EXISTS session_messages;

DROP TABLE IF EXISTS session_turns;

DROP TABLE IF EXISTS session_message_drafts;

DROP TABLE IF EXISTS meta;

ALTER TABLE sessions DROP COLUMN revision;
`;

export const migration: Migration = {
  id: "20261123130000_drop_legacy_session_tables",
  checksum: checksumSql(DDL),
  up(db) {
    db.exec(DDL);
  },
};
