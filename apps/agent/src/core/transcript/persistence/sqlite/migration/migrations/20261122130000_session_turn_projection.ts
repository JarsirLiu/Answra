import { checksumSql } from "../checksum";
import type { Migration } from "../types";

const DDL = `
CREATE TABLE session_turns_next (
  conversation_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  finish_reason TEXT,
  entry_agent_id TEXT,
  active_agent_id TEXT,
  input_message_id TEXT,
  origin_session_id TEXT,
  origin_turn_id TEXT,
  origin_agent_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, turn_id),
  UNIQUE (conversation_id, seq)
);

INSERT INTO session_turns_next
  (conversation_id, turn_id, seq, source, status, finish_reason, entry_agent_id,
   active_agent_id, input_message_id, origin_session_id, origin_turn_id,
   origin_agent_id, created_at, updated_at)
SELECT
  conversation_id, turn_id, seq, source, status, finish_reason, entry_agent_id,
  active_agent_id, input_message_id, origin_session_id, origin_turn_id,
  origin_agent_id, created_at, updated_at
FROM session_turns;

DROP TABLE session_turns;

ALTER TABLE session_turns_next RENAME TO session_turns;

CREATE TRIGGER sessions_delete_session_turns
AFTER DELETE ON sessions
BEGIN
  DELETE FROM session_turns WHERE conversation_id = OLD.conversation_id;
END;
`;

export const migration: Migration = {
  id: "20261122130000_session_turn_projection",
  checksum: checksumSql(DDL),
  up(db) {
    db.exec(DDL);
  },
};
