import { checksumSql } from "../checksum";
import type { Migration } from "../types";

const DDL = `
CREATE TABLE session_events (
  conversation_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  turn_id TEXT,
  message_id TEXT,
  step_id TEXT,
  operation_id TEXT,
  producer_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  event_json TEXT NOT NULL,
  PRIMARY KEY (conversation_id, seq),
  UNIQUE (conversation_id, event_id)
);

CREATE INDEX session_events_turn
  ON session_events(conversation_id, turn_id, seq);

CREATE INDEX session_events_step
  ON session_events(conversation_id, step_id, seq);

CREATE TRIGGER sessions_delete_session_events
AFTER DELETE ON sessions
BEGIN
  DELETE FROM session_events WHERE conversation_id = OLD.conversation_id;
END;
`;

export const migration: Migration = {
  id: "20261122120000_add_session_events",
  checksum: checksumSql(DDL),
  up(db) {
    db.exec(DDL);
  },
};
