/** 会话数据库当前完整 schema；`baseline`、迁移和校验都从这里取值。 */
export const SESSION_SCHEMA_SQL = `
CREATE TABLE sessions (
  conversation_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  workspace_root TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  state_json TEXT NOT NULL
);

CREATE INDEX sessions_scope_updated ON sessions(scope, updated_at DESC);
CREATE INDEX sessions_scope_workspace_updated
  ON sessions(scope, workspace_root, updated_at DESC, conversation_id ASC);

CREATE TABLE session_messages (
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  turn_id TEXT,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  message_json TEXT NOT NULL,
  PRIMARY KEY (conversation_id, message_id),
  UNIQUE (conversation_id, seq),
  FOREIGN KEY (conversation_id) REFERENCES sessions(conversation_id) ON DELETE CASCADE
);

CREATE INDEX session_messages_seq
  ON session_messages(conversation_id, seq DESC);

CREATE INDEX session_messages_turn
  ON session_messages(conversation_id, turn_id, seq);

CREATE TABLE session_turns (
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

CREATE TRIGGER sessions_delete_session_turns
AFTER DELETE ON sessions
BEGIN
  DELETE FROM session_turns WHERE conversation_id = OLD.conversation_id;
END;

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

CREATE TABLE session_message_drafts (
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  draft_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, message_id),
  FOREIGN KEY (conversation_id) REFERENCES sessions(conversation_id) ON DELETE CASCADE
);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
