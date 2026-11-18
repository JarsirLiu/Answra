/** 迁移与 schema 的快照校验；规范化空白后计算稳定 SHA-256。 */
import { createHash } from "node:crypto";

export function checksumSql(sql: string): string {
  return createHash("sha256").update(normalizeSql(sql)).digest("hex");
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}
