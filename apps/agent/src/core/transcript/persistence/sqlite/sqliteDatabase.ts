/** SQLite 连接与启动迁移；只负责数据库生命周期，不承载 transcript 语义。 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sessionDatabasePath } from "../legacySessionFiles";
import { MIGRATIONS } from "./migration/registry.gen";
import { runMigrations } from "./migration/runner";

export function openSessionDatabase(root: string): DatabaseSync {
  const filePath = sessionDatabasePath(root);
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  try {
    runMigrations(db, filePath, { migrations: MIGRATIONS });
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
