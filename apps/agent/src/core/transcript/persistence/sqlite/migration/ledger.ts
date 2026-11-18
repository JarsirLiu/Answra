/** 迁移账本：记录已应用 migration 的 id、checksum 与应用时间。 */
import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "./types";

export const MIGRATION_LEDGER_TABLE = "_migrations";

export interface AppliedMigration {
  readonly id: string;
  readonly checksum: string;
  readonly appliedAt: number;
}

export function hasMigrationLedger(db: DatabaseSync): boolean {
  return tableExists(db, MIGRATION_LEDGER_TABLE);
}

export function ensureMigrationLedger(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${MIGRATION_LEDGER_TABLE} (
      id TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);
}

export function readAppliedMigrations(db: DatabaseSync): AppliedMigration[] {
  return db
    .prepare(
      `SELECT id, checksum, applied_at AS appliedAt
       FROM ${MIGRATION_LEDGER_TABLE}
       ORDER BY id ASC`,
    )
    .all() as unknown as AppliedMigration[];
}

export function recordMigration(db: DatabaseSync, migration: Migration, appliedAt: number): void {
  db.prepare(
    `INSERT INTO ${MIGRATION_LEDGER_TABLE} (id, checksum, applied_at)
     VALUES (?, ?, ?)`,
  ).run(migration.id, migration.checksum, appliedAt);
}

export function seedAppliedMigrations(
  db: DatabaseSync,
  migrations: readonly Migration[],
  appliedAt: number,
): void {
  const insert = db.prepare(
    `INSERT INTO ${MIGRATION_LEDGER_TABLE} (id, checksum, applied_at)
     VALUES (?, ?, ?)`,
  );
  for (const migration of migrations) {
    insert.run(migration.id, migration.checksum, appliedAt);
  }
}

export function listUserTables(db: DatabaseSync): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_schema
         WHERE type = 'table'
           AND name NOT LIKE 'sqlite_%'
           AND name <> ?
         ORDER BY name ASC`,
      )
      .all(MIGRATION_LEDGER_TABLE) as unknown as { name: string }[]
  ).map((row) => row.name);
}

export function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(table) as { present: number } | undefined;
  return row !== undefined;
}
