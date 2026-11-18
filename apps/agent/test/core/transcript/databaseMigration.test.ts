import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { checksumSql } from "../../../src/core/transcript/persistence/sqlite/migration/checksum";
import {
  MIGRATION_LEDGER_TABLE,
  readAppliedMigrations,
  tableExists,
} from "../../../src/core/transcript/persistence/sqlite/migration/ledger";
import { runMigrations } from "../../../src/core/transcript/persistence/sqlite/migration/runner";
import type { Migration } from "../../../src/core/transcript/persistence/sqlite/migration/types";

const roots: string[] = [];
const databases: DatabaseSync[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "answra-migration-"));
  roots.push(root);
  return root;
}

function openDatabase(filePath: string): DatabaseSync {
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  databases.push(db);
  return db;
}

function probeMigration(upCalls: { count: number }): Migration {
  return {
    id: "20261118120000_create_probe",
    checksum: checksumSql("CREATE TABLE migration_probe (id TEXT NOT NULL);"),
    up(db) {
      upCalls.count += 1;
      db.exec("CREATE TABLE migration_probe (id TEXT NOT NULL);");
    },
  };
}

async function backupFiles(root: string): Promise<string[]> {
  return (await readdir(root)).filter((name) => name.includes(".backup-"));
}

afterEach(async () => {
  for (const db of databases.splice(0)) {
    try {
      db.close();
    } catch {
      // 已关闭的测试数据库不需要重复报错。
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SQLite migration runner", () => {
  it("creates a baseline and seeds every known migration without running it", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "sessions.sqlite");
    await mkdir(root, { recursive: true });
    const db = openDatabase(filePath);
    const upCalls = { count: 0 };
    const migration = probeMigration(upCalls);

    runMigrations(db, filePath, { migrations: [migration], now: () => 1_000 });

    expect(tableExists(db, "sessions")).toBe(true);
    expect(tableExists(db, "migration_probe")).toBe(false);
    expect(upCalls.count).toBe(0);
    expect(readAppliedMigrations(db)).toEqual([
      { id: migration.id, checksum: migration.checksum, appliedAt: 1_000 },
    ]);
    expect(await backupFiles(root)).toEqual([]);
  });

  it("applies only missing migrations, records them and creates a backup", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "sessions.sqlite");
    await mkdir(root, { recursive: true });
    const db = openDatabase(filePath);
    runMigrations(db, filePath, { migrations: [], now: () => 1_000 });

    const upCalls = { count: 0 };
    const migration = probeMigration(upCalls);
    runMigrations(db, filePath, { migrations: [migration], now: () => 2_000 });

    expect(tableExists(db, "migration_probe")).toBe(true);
    expect(upCalls.count).toBe(1);
    expect(readAppliedMigrations(db)).toEqual([
      { id: migration.id, checksum: migration.checksum, appliedAt: 2_000 },
    ]);
    expect(await backupFiles(root)).toHaveLength(1);
  });

  it("is idempotent when the database is already current", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "sessions.sqlite");
    await mkdir(root, { recursive: true });
    const db = openDatabase(filePath);
    runMigrations(db, filePath, { migrations: [], now: () => 1_000 });
    const before = readAppliedMigrations(db);

    runMigrations(db, filePath, { migrations: [], now: () => 2_000 });

    expect(readAppliedMigrations(db)).toEqual(before);
    expect(await backupFiles(root)).toEqual([]);
  });

  it("rejects a changed checksum instead of accepting an edited migration", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "sessions.sqlite");
    await mkdir(root, { recursive: true });
    const db = openDatabase(filePath);
    const original = probeMigration({ count: 0 });
    runMigrations(db, filePath, { migrations: [original], now: () => 1_000 });

    const changed: Migration = {
      ...original,
      checksum: checksumSql("ALTER TABLE sessions ADD COLUMN x TEXT;"),
    };

    expect(() => runMigrations(db, filePath, { migrations: [changed], now: () => 2_000 })).toThrow(
      `迁移 ${original.id} 的 checksum 已变化`,
    );
  });

  it("rejects a database that contains a migration unknown to the program", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "sessions.sqlite");
    await mkdir(root, { recursive: true });
    const db = openDatabase(filePath);
    const migration = probeMigration({ count: 0 });
    runMigrations(db, filePath, { migrations: [migration], now: () => 1_000 });

    expect(() => runMigrations(db, filePath, { migrations: [], now: () => 2_000 })).toThrow(
      `不认识的迁移 ${migration.id}`,
    );
  });

  it("rolls back a failed migration and keeps the original database", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "sessions.sqlite");
    await mkdir(root, { recursive: true });
    const db = openDatabase(filePath);
    runMigrations(db, filePath, { migrations: [], now: () => 1_000 });

    const failing: Migration = {
      id: "20261118130000_failing_probe",
      checksum: checksumSql("CREATE TABLE failed_probe (id TEXT NOT NULL);"),
      up(transaction) {
        transaction.exec("CREATE TABLE failed_probe (id TEXT NOT NULL)");
        throw new Error("migration failed");
      },
    };

    expect(() => runMigrations(db, filePath, { migrations: [failing], now: () => 2_000 })).toThrow(
      "migration failed",
    );

    expect(tableExists(db, "failed_probe")).toBe(false);
    expect(readAppliedMigrations(db)).toEqual([]);
    expect(await backupFiles(root)).toHaveLength(1);
  });

  it("rejects a pre-ledger development database without deleting it", async () => {
    const root = await createRoot();
    const filePath = path.join(root, "sessions.sqlite");
    await mkdir(root, { recursive: true });
    const db = openDatabase(filePath);
    db.exec("CREATE TABLE sessions (conversation_id TEXT PRIMARY KEY)");

    expect(() => runMigrations(db, filePath, { migrations: [], now: () => 1_000 })).toThrow(
      "pnpm db:reset",
    );
    expect(tableExists(db, "sessions")).toBe(true);
    expect(tableExists(db, MIGRATION_LEDGER_TABLE)).toBe(false);
  });
});
