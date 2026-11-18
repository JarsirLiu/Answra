/** SQLite 写事务原语；所有需要原子提交的 DDL 与业务写入共用这里。 */
import type { DatabaseSync } from "node:sqlite";

export function withImmediateTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
