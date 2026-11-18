/** `pnpm db:check`：校验生成物、fresh DB 与启动幂等性。 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BASELINE_CHECKSUM } from "../../src/core/transcript/persistence/sqlite/migration/baseline";
import { MIGRATION_LEDGER_TABLE } from "../../src/core/transcript/persistence/sqlite/migration/ledger";
import { MIGRATION_POLICY } from "../../src/core/transcript/persistence/sqlite/migration/policy";
import { MIGRATIONS } from "../../src/core/transcript/persistence/sqlite/migration/registry.gen";
import { SESSION_SCHEMA_SQL } from "../../src/core/transcript/persistence/sqlite/schema";
import { openSessionDatabase } from "../../src/core/transcript/persistence/sqlite/sqliteDatabase";
import {
  loadMigrationFiles,
  readRegistrySource,
  readSnapshot,
  renderRegistry,
  type SchemaSnapshot,
} from "./artifacts";

interface SchemaRow {
  readonly type: string;
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string | null;
}

async function main(): Promise<void> {
  const files = await loadMigrationFiles();
  assert.equal(
    readRegistrySource(),
    renderRegistry(files),
    "registry.gen.ts 已过期，请运行 pnpm db:generate。",
  );

  const snapshot = readSnapshot();
  assert.ok(snapshot !== undefined, "缺少 schema.snapshot.json，请运行 pnpm db:generate。");
  assertSnapshot(snapshot);

  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "answra-db-check-"));
  try {
    checkFreshDatabase(path.join(tempRoot, "sessions"));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
  console.log(`数据库检查通过（${MIGRATIONS.length} 个迁移，策略 ${MIGRATION_POLICY}）。`);
}

function assertSnapshot(snapshot: SchemaSnapshot): void {
  const currentIds = MIGRATIONS.map((migration) => migration.id);
  assert.deepEqual(
    currentIds,
    Object.keys(snapshot.migrations),
    "migration registry 与 schema.snapshot.json 不一致，请运行 pnpm db:generate。",
  );
  for (const migration of MIGRATIONS) {
    assert.equal(
      migration.checksum,
      snapshot.migrations[migration.id],
      `迁移 ${migration.id} 的 checksum 与快照不一致。`,
    );
  }
  if (MIGRATION_POLICY === "pre-release") {
    assert.equal(
      BASELINE_CHECKSUM,
      snapshot.schemaChecksum,
      "schema 已变化但 schema.snapshot.json 未更新，请运行 pnpm db:generate。",
    );
    return;
  }
  if (BASELINE_CHECKSUM !== snapshot.schemaChecksum) {
    const known = new Set(Object.keys(snapshot.migrations));
    assert.ok(
      MIGRATIONS.some((migration) => !known.has(migration.id)),
      "schema 已变化但没有新增 migration；发布后必须 append-only。",
    );
  }
}

function checkFreshDatabase(root: string): void {
  let actual = openSessionDatabase(root);
  const expected = new DatabaseSync(":memory:");
  try {
    expected.exec(SESSION_SCHEMA_SQL);
    assert.deepEqual(readSchema(actual), readSchema(expected));
    assert.deepEqual(
      readLedger(actual),
      MIGRATIONS.map((migration) => migration.id),
    );

    const before = readLedger(actual);
    actual.close();
    actual = openSessionDatabase(root);
    assert.deepEqual(readLedger(actual), before);
    assert.deepEqual(readSchema(actual), readSchema(expected));
  } finally {
    expected.close();
    actual.close();
  }
}

function readSchema(db: DatabaseSync): SchemaRow[] {
  return db
    .prepare(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%'
         AND name <> ?
       ORDER BY type ASC, name ASC`,
    )
    .all(MIGRATION_LEDGER_TABLE) as unknown as SchemaRow[];
}

function readLedger(db: DatabaseSync): string[] {
  return (
    db.prepare(`SELECT id FROM ${MIGRATION_LEDGER_TABLE} ORDER BY id ASC`).all() as unknown as {
      id: string;
    }[]
  ).map((row) => row.id);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
