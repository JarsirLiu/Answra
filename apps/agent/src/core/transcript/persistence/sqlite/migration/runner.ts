/** 启动迁移 runner：新库走 baseline，旧库按账本执行缺失 migration。 */
import type { DatabaseSync } from "node:sqlite";
import { withImmediateTransaction } from "../transaction";
import { backupDatabase } from "./backup";
import { BASELINE_SQL } from "./baseline";
import {
  type AppliedMigration,
  ensureMigrationLedger,
  hasMigrationLedger,
  listUserTables,
  readAppliedMigrations,
  recordMigration,
  seedAppliedMigrations,
  tableExists,
} from "./ledger";
import { MIGRATION_POLICY } from "./policy";
import type { Migration } from "./types";

const MIGRATION_ID_PATTERN = /^\d{14}_[a-z0-9_]+$/;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;

export interface RunMigrationsOptions {
  readonly migrations: readonly Migration[];
  readonly now?: () => number;
}

export function runMigrations(
  db: DatabaseSync,
  filePath: string,
  options: RunMigrationsOptions,
): void {
  assertMigrationRegistry(options.migrations);
  const applied = hasMigrationLedger(db) ? readAppliedMigrations(db) : undefined;
  if (applied === undefined) {
    assertEmptyDatabase(db, filePath);
    withImmediateTransaction(db, () => {
      ensureMigrationLedger(db);
      db.exec(BASELINE_SQL);
      seedAppliedMigrations(db, options.migrations, now(options));
    });
    return;
  }

  assertSessionSchemaPresent(db, filePath);
  assertAppliedMigrations(applied, options.migrations, filePath);
  const pending = findPendingMigrations(applied, options.migrations);
  if (pending.length === 0) return;

  backupDatabase(db, filePath, now(options));
  for (const migration of pending) {
    withImmediateTransaction(db, () => {
      const current = readAppliedMigrations(db);
      assertAppliedMigrations(current, options.migrations, filePath);
      if (current.some((row) => row.id === migration.id)) return;
      migration.up(db);
      recordMigration(db, migration, now(options));
    });
  }
}

function assertEmptyDatabase(db: DatabaseSync, filePath: string): void {
  const tables = listUserTables(db);
  if (tables.length > 0) {
    const action =
      MIGRATION_POLICY === "pre-release"
        ? "开发期请运行 pnpm db:reset --yes 后重试。"
        : "请保留数据库文件并报告问题。";
    throw new Error(`会话数据库缺少迁移账本，无法安全升级：${filePath}。${action}`);
  }
}

function assertSessionSchemaPresent(db: DatabaseSync, filePath: string): void {
  if (!tableExists(db, "sessions")) {
    throw new Error(
      `会话数据库已有迁移账本但缺少业务表，数据库可能已损坏：${filePath}。请保留文件并报告问题。`,
    );
  }
}

function assertMigrationRegistry(migrations: readonly Migration[]): void {
  const seen = new Set<string>();
  let previousId = "";
  for (const migration of migrations) {
    if (!MIGRATION_ID_PATTERN.test(migration.id)) {
      throw new Error(`迁移 id 无效：${migration.id}。应使用 YYYYMMDDHHMMSS_description。`);
    }
    if (!CHECKSUM_PATTERN.test(migration.checksum)) {
      throw new Error(`迁移 ${migration.id} 的 checksum 无效。`);
    }
    if (seen.has(migration.id)) throw new Error(`迁移 id 重复：${migration.id}`);
    if (migration.id <= previousId) throw new Error(`迁移必须按 id 升序排列：${migration.id}`);
    seen.add(migration.id);
    previousId = migration.id;
  }
}

function assertAppliedMigrations(
  applied: readonly AppliedMigration[],
  migrations: readonly Migration[],
  filePath: string,
): void {
  const known = new Map(migrations.map((migration) => [migration.id, migration]));
  for (const row of applied) {
    const migration = known.get(row.id);
    if (migration === undefined) {
      throw new Error(
        `会话数据库包含当前程序不认识的迁移 ${row.id}，数据库版本高于程序：${filePath}。请升级程序后重试。`,
      );
    }
    if (migration.checksum !== row.checksum) {
      throw new Error(
        `会话数据库迁移 ${row.id} 的 checksum 已变化：${filePath}。已发布迁移不得修改，请保留文件并报告问题。`,
      );
    }
  }
}

function findPendingMigrations(
  applied: readonly AppliedMigration[],
  migrations: readonly Migration[],
): Migration[] {
  const appliedIds = new Set(applied.map((row) => row.id));
  return migrations.filter((migration) => !appliedIds.has(migration.id));
}

function now(options: RunMigrationsOptions): number {
  return (options.now ?? Date.now)();
}
