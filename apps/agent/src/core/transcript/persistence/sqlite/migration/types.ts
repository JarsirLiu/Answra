/** 一条已发布 schema 变更；`up` 必须只包含可重复验证的同步 DDL。 */
import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  readonly id: string;
  readonly checksum: string;
  up(db: DatabaseSync): void;
}
