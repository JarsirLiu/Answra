/** 会话数据库当前完整 schema；`baseline`、迁移和校验都从这里取值。 */
export const SESSION_SCHEMA_SQL = `
CREATE TABLE sessions (
  conversation_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  workspace_root TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  title TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  next_seq INTEGER NOT NULL DEFAULT 1,
  open_turn_id TEXT,
  state_json TEXT NOT NULL
);

CREATE INDEX sessions_scope_updated ON sessions(scope, updated_at DESC);
CREATE INDEX sessions_scope_workspace_updated
  ON sessions(scope, workspace_root, updated_at DESC, conversation_id ASC);

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
