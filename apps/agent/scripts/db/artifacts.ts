/** 数据库脚本共享的文件与生成物读写；只用于开发期，不进入运行时 bundle。 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Migration } from "../../src/core/transcript/persistence/sqlite/migration/types";

export const MIGRATION_DIR = path.resolve(
  import.meta.dirname,
  "../../src/core/transcript/persistence/sqlite/migration",
);
export const MIGRATIONS_DIR = path.join(MIGRATION_DIR, "migrations");
export const REGISTRY_PATH = path.join(MIGRATION_DIR, "registry.gen.ts");
export const SNAPSHOT_PATH = path.join(MIGRATION_DIR, "schema.snapshot.json");

const MIGRATION_FILE_PATTERN = /^\d{14}_[a-z0-9_]+\.ts$/;

export interface SchemaSnapshot {
  readonly schemaChecksum: string;
  readonly migrations: Readonly<Record<string, string>>;
}

export interface LoadedMigration {
  readonly filePath: string;
  readonly migration: Migration;
}

export async function loadMigrationFiles(): Promise<LoadedMigration[]> {
  if (!existsSync(MIGRATIONS_DIR)) return [];
  const allFiles = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".ts"));
  const unexpected = allFiles.filter((name) => !MIGRATION_FILE_PATTERN.test(name));
  if (unexpected.length > 0) {
    throw new Error(`migration 文件名无效：${unexpected.join(", ")}。`);
  }
  const files = allFiles.sort();
  const loaded: LoadedMigration[] = [];
  for (const file of files) {
    const filePath = path.join(MIGRATIONS_DIR, file);
    const module = (await import(pathToFileURL(filePath).href)) as { migration?: Migration };
    if (module.migration === undefined) {
      throw new Error(`${file} 必须导出命名迁移 migration。`);
    }
    if (module.migration.id !== path.basename(file, ".ts")) {
      throw new Error(`${file} 的 migration.id 必须与文件名一致。`);
    }
    loaded.push({ filePath, migration: module.migration });
  }
  return loaded;
}

export function renderRegistry(files: readonly LoadedMigration[]): string {
  const lines = ["/** 由 `pnpm db:generate` 生成；请勿手工编辑。 */"];
  lines.push('import type { Migration } from "./types";');
  for (const [index, { filePath }] of files.entries()) {
    const name = path.basename(filePath, ".ts");
    lines.push(`import { migration as migration${index} } from "./migrations/${name}";`);
  }
  lines.push("");
  if (files.length === 0) {
    lines.push("export const MIGRATIONS: readonly Migration[] = [];");
  } else {
    lines.push("export const MIGRATIONS: readonly Migration[] = [");
    for (const [index] of files.entries()) lines.push(`  migration${index},`);
    lines.push("];");
  }
  lines.push("");
  return lines.join("\n");
}

export function readRegistrySource(): string {
  return readFileSync(REGISTRY_PATH, "utf8");
}

export function readSnapshot(): SchemaSnapshot | undefined {
  if (!existsSync(SNAPSHOT_PATH)) return undefined;
  return JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as SchemaSnapshot;
}

export function renderSnapshot(snapshot: SchemaSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}
