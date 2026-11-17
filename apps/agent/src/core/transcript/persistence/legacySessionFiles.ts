/** 旧 JSON 会话文件路径与归档；只用于首次迁移，不是运行时存储。 */
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LEGACY_DIRECTORY = "legacy";

export function isConversationId(value: unknown): value is string {
  return typeof value === "string" && CONVERSATION_ID_PATTERN.test(value);
}

export function sessionDatabasePath(root: string): string {
  return join(resolve(root), "sessions.sqlite");
}

export function isLegacySessionFileName(name: string): boolean {
  return name.endsWith(".json") && isConversationId(name.slice(0, -5));
}

export function legacySessionFilePath(root: string, name: string): string {
  const base = resolve(root);
  const filePath = resolve(base, name);
  if (!filePath.startsWith(`${base}${sep}`)) throw new Error("会话路径无效");
  return filePath;
}

export function listLegacySessionFiles(root: string): string[] {
  return readdirSync(resolve(root))
    .filter(isLegacySessionFileName)
    .map((name) => legacySessionFilePath(root, name));
}

export function archiveLegacySessionFile(root: string, filePath: string, corrupt: boolean): void {
  const archiveDir = join(resolve(root), LEGACY_DIRECTORY);
  mkdirSync(archiveDir, { recursive: true });
  const name = filePath.slice(filePath.lastIndexOf(sep) + 1);
  const archivedName = corrupt ? `${name}.corrupt-${Date.now()}` : name;
  const target = join(archiveDir, archivedName);
  renameSync(filePath, existsSync(target) ? `${target}.${Date.now()}` : target);
}
