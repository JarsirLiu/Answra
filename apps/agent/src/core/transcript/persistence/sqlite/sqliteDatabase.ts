/** SQLite 连接与 schema 迁移；只负责数据库生命周期，不承载 transcript 语义。 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sessionDatabasePath } from "../legacySessionFiles";

const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE sessions (
  conversation_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  workspace_root TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL,
  title TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  record_json TEXT NOT NULL
);

CREATE INDEX sessions_scope_updated ON sessions(scope, updated_at DESC);
CREATE INDEX sessions_scope_workspace_updated
  ON sessions(scope, workspace_root, updated_at DESC, conversation_id ASC);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE quarantined_sessions (
  conversation_id TEXT NOT NULL,
  record_json TEXT,
  reason TEXT NOT NULL,
  quarantined_at TEXT NOT NULL
);
`;

export function openSessionDatabase(root: string): DatabaseSync {
  const filePath = sessionDatabasePath(root);
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  const version = row?.user_version ?? 0;
  if (version > SCHEMA_VERSION) {
    db.close();
    throw new Error(`会话数据库版本过新：${version}`);
  }
  if (version === SCHEMA_VERSION) return;
  withImmediateTransaction(db, () => {
    if (version === 0) {
      db.exec(SCHEMA);
    } else if (version === 1) {
      db.exec("ALTER TABLE sessions ADD COLUMN title TEXT");
      db.exec("ALTER TABLE sessions ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0");
      db.exec(`
        CREATE INDEX sessions_scope_workspace_updated
          ON sessions(scope, workspace_root, updated_at DESC, conversation_id ASC)
      `);
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
}

export function withImmediateTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
