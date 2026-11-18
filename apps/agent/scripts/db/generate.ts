/** `pnpm db:generate`：重建 registry 与 schema 快照，并阻止发布后漏迁移。 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { BASELINE_CHECKSUM } from "../../src/core/transcript/persistence/sqlite/migration/baseline";
import { MIGRATION_POLICY } from "../../src/core/transcript/persistence/sqlite/migration/policy";
import {
  loadMigrationFiles,
  REGISTRY_PATH,
  readSnapshot,
  renderRegistry,
  renderSnapshot,
  SNAPSHOT_PATH,
} from "./artifacts";

async function main(): Promise<void> {
  const files = await loadMigrationFiles();
  const nextMigrations = Object.fromEntries(
    files.map(({ migration }) => [migration.id, migration.checksum]),
  );
  if (MIGRATION_POLICY === "released") {
    assertReleasedUpdate(nextMigrations);
  }

  writeFileSync(REGISTRY_PATH, renderRegistry(files), "utf8");
  writeFileSync(
    SNAPSHOT_PATH,
    renderSnapshot({ schemaChecksum: BASELINE_CHECKSUM, migrations: nextMigrations }),
    "utf8",
  );
  console.log(`已生成 ${files.length} 个迁移注册项与 schema 快照。`);
}

function assertReleasedUpdate(nextMigrations: Readonly<Record<string, string>>): void {
  const previous = readSnapshot();
  if (previous === undefined) {
    throw new Error("发布后缺少 schema.snapshot.json，无法确认迁移历史。");
  }
  for (const [id, checksum] of Object.entries(previous.migrations)) {
    if (nextMigrations[id] !== checksum) {
      throw new Error(`已发布迁移 ${id} 被修改或删除；修正必须新增 migration。`);
    }
  }
  if (BASELINE_CHECKSUM === previous.schemaChecksum) return;
  const previousIds = new Set(Object.keys(previous.migrations));
  assert.ok(
    Object.keys(nextMigrations).some((id) => !previousIds.has(id)),
    "schema 已变化但没有新增 migration；发布后必须 append-only。",
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
