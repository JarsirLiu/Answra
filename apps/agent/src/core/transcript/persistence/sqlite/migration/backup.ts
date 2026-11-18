/** 迁移前数据库备份；只在新库以外的待迁移数据库上执行。 */
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

const BACKUP_SUFFIX = ".backup-";

export function backupDatabase(db: DatabaseSync, filePath: string, timestamp: number): string {
  const backupPath = uniqueBackupPath(filePath, timestamp);
  db.exec(`VACUUM INTO ${quoteSqlString(backupPath)}`);
  return backupPath;
}

function uniqueBackupPath(filePath: string, timestamp: number): string {
  const base = `${filePath}${BACKUP_SUFFIX}${timestamp}-${process.pid}`;
  let candidate = base;
  let suffix = 1;
  while (existsSync(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
