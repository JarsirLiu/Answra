/** 当前完整 schema 的基线；新库只应用这里，不重放历史 migration。 */
import { SESSION_SCHEMA_SQL } from "../schema";
import { checksumSql } from "./checksum";

export const BASELINE_SQL = SESSION_SCHEMA_SQL;
export const BASELINE_CHECKSUM = checksumSql(BASELINE_SQL);
