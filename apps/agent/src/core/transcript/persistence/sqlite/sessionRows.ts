/** sessions 表的行读写与解析边界；不包含业务状态机。 */

import type { DatabaseSync } from "node:sqlite";
import type { ConversationSessionScope } from "@answra/shared";
import {
  parseSessionRecord,
  type SessionRecordPayload,
  summarizeSessionRecord,
} from "../sessionRecord";
import type { SessionCursor } from "./sessionCursor";

export interface StoredSessionRow {
  conversationId: string;
  revision: number;
  record: SessionRecordPayload;
}

export interface SessionListRow {
  conversationId: string;
  scope: ConversationSessionScope;
  workspaceRoot?: string;
  createdAt: string;
  updatedAt: string;
  title: string | null;
  messageCount: number;
  recordJson: string;
}

export class SessionRecordParseError extends Error {
  readonly conversationId: string;

  constructor(conversationId: string, cause: unknown) {
    super(
      `数据库会话记录无法解析：${conversationId}（${
        cause instanceof Error ? cause.message : String(cause)
      }）`,
    );
    this.name = "SessionRecordParseError";
    this.conversationId = conversationId;
    this.cause = cause;
  }
}

export function insertSessionRow(
  db: DatabaseSync,
  payload: SessionRecordPayload,
  revision: number,
): number {
  const summary = summarizeSessionRecord(payload);
  const result = db
    .prepare(`
      INSERT OR IGNORE INTO sessions
        (conversation_id, scope, workspace_root, created_at, updated_at, revision,
         title, message_count, record_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      payload.conversationId,
      payload.scope,
      payload.workspaceRoot ?? null,
      payload.createdAt,
      payload.updatedAt,
      revision,
      summary.title,
      summary.messageCount,
      JSON.stringify(payload),
    );
  return Number(result.changes);
}

export function updateSessionRow(
  db: DatabaseSync,
  payload: SessionRecordPayload,
  expectedRevision: number,
): number {
  const summary = summarizeSessionRecord(payload);
  const result = db
    .prepare(`
      UPDATE sessions
      SET scope = ?, workspace_root = ?, created_at = ?, updated_at = ?,
          revision = ?, title = ?, message_count = ?, record_json = ?
      WHERE conversation_id = ? AND revision = ?
    `)
    .run(
      payload.scope,
      payload.workspaceRoot ?? null,
      payload.createdAt,
      payload.updatedAt,
      expectedRevision + 1,
      summary.title,
      summary.messageCount,
      JSON.stringify(payload),
      payload.conversationId,
      expectedRevision,
    );
  return Number(result.changes);
}

export function readSessionRow(
  db: DatabaseSync,
  conversationId: string,
): StoredSessionRow | undefined {
  const row = db
    .prepare("SELECT record_json, revision FROM sessions WHERE conversation_id = ?")
    .get(conversationId) as { record_json: string; revision: number } | undefined;
  if (!row) return undefined;
  return {
    conversationId,
    revision: row.revision,
    record: parseStoredRecord(conversationId, row.record_json),
  };
}

export function parseStoredRecord(
  conversationId: string,
  recordJson: string,
): SessionRecordPayload {
  try {
    const parsed = JSON.parse(recordJson) as unknown;
    const record = parseSessionRecord(parsed);
    if (record.conversationId !== conversationId) throw new Error("数据库会话 ID 与行不一致");
    return record;
  } catch (error) {
    throw new SessionRecordParseError(conversationId, error);
  }
}

export function listSessionRows(
  db: DatabaseSync,
  filters: {
    scope?: ConversationSessionScope;
    workspaceRoot?: string;
    cursor?: SessionCursor;
    limit: number;
  },
): SessionListRow[] {
  const clauses = ["scope <> 'answer'"];
  const parameters: Array<string | number> = [];
  if (filters.scope !== undefined) {
    clauses.push("scope = ?");
    parameters.push(filters.scope);
  }
  if (filters.workspaceRoot !== undefined) {
    clauses.push("workspace_root = ?");
    parameters.push(filters.workspaceRoot);
  }
  if (filters.cursor !== undefined) {
    clauses.push("(updated_at < ? OR (updated_at = ? AND conversation_id > ?))");
    parameters.push(
      filters.cursor.updatedAt,
      filters.cursor.updatedAt,
      filters.cursor.conversationId,
    );
  }
  parameters.push(filters.limit);
  const rows = db
    .prepare(`
      SELECT conversation_id, scope, workspace_root, created_at, updated_at,
             title, message_count, record_json
      FROM sessions
      WHERE ${clauses.join(" AND ")}
      ORDER BY updated_at DESC, conversation_id ASC
      LIMIT ?
    `)
    .all(...parameters) as unknown as StoredSummaryColumns[];
  return rows.map((row) => ({
    conversationId: row.conversation_id,
    scope: row.scope,
    ...(row.workspace_root === null ? {} : { workspaceRoot: row.workspace_root }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    title: row.title,
    messageCount: row.message_count,
    recordJson: row.record_json,
  }));
}

export function deleteSessionRow(db: DatabaseSync, conversationId: string): void {
  db.prepare("DELETE FROM sessions WHERE conversation_id = ?").run(conversationId);
}

export function quarantineSessionRow(
  db: DatabaseSync,
  conversationId: string,
  recordJson: string | null,
  reason: string,
): void {
  db.prepare(`
    INSERT INTO quarantined_sessions
      (conversation_id, record_json, reason, quarantined_at)
    VALUES (?, ?, ?, ?)
  `).run(conversationId, recordJson, reason, new Date().toISOString());
  deleteSessionRow(db, conversationId);
}

export function backfillSessionSummaries(db: DatabaseSync): void {
  const rows = db
    .prepare("SELECT conversation_id, record_json FROM sessions WHERE title IS NULL")
    .all() as Array<{ conversation_id: string; record_json: string }>;
  for (const row of rows) {
    try {
      const record = parseStoredRecord(row.conversation_id, row.record_json);
      const summary = summarizeSessionRecord(record);
      db.prepare("UPDATE sessions SET title = ?, message_count = ? WHERE conversation_id = ?").run(
        summary.title,
        summary.messageCount,
        row.conversation_id,
      );
    } catch (error) {
      if (!(error instanceof SessionRecordParseError)) throw error;
      quarantineSessionRow(db, row.conversation_id, row.record_json, error.message);
    }
  }
}

export function hasMeta(db: DatabaseSync, key: string): boolean {
  return db.prepare("SELECT 1 FROM meta WHERE key = ?").get(key) !== undefined;
}

export function writeMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
}

interface StoredSummaryColumns {
  conversation_id: string;
  scope: ConversationSessionScope;
  workspace_root: string | null;
  created_at: string;
  updated_at: string;
  title: string | null;
  message_count: number;
  record_json: string;
}
