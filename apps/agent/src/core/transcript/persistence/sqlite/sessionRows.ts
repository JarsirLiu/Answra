/** sessions 行读写与解析边界；消息正文在 session_items，由条目存储维护。 */
import type { DatabaseSync } from "node:sqlite";
import type { ConversationSessionScope } from "@answra/shared";
import type { SessionStatePayload } from "../sessionRecord";
import { parseSessionStatePayload } from "../sessionRecord";
import { workspaceStorageKey } from "../workspaceKey";
import type { SessionCursor } from "./sessionCursor";

export interface SessionRowInput {
  state: SessionStatePayload;
  scope: ConversationSessionScope;
  workspaceRoot?: string;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoredSessionRow {
  conversationId: string;
  revision: number;
  state: SessionStatePayload;
  scope: ConversationSessionScope;
  workspaceRoot?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionListRow {
  conversationId: string;
  scope: ConversationSessionScope;
  workspaceRoot?: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  messageCount: number;
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
  input: SessionRowInput,
  revision: number,
): number {
  const result = db
    .prepare(`
      INSERT INTO sessions
        (conversation_id, scope, workspace_root, created_at, updated_at, revision,
         title, message_count, state_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      input.state.conversationId,
      input.scope,
      input.workspaceRoot ?? null,
      input.createdAt,
      input.updatedAt,
      revision,
      input.title,
      input.messageCount,
      JSON.stringify(input.state),
    );
  return Number(result.changes);
}

export function updateSessionRow(
  db: DatabaseSync,
  input: SessionRowInput,
  expectedRevision: number,
): number {
  // `message_count` 与 `updated_at` 由条目写入维护；这里只改会话元数据与游标状态。
  const result = db
    .prepare(`
      UPDATE sessions
      SET scope = ?, workspace_root = ?, revision = ?, title = ?, state_json = ?
      WHERE conversation_id = ? AND revision = ?
    `)
    .run(
      input.scope,
      input.workspaceRoot ?? null,
      expectedRevision + 1,
      input.title,
      JSON.stringify(input.state),
      input.state.conversationId,
      expectedRevision,
    );
  return Number(result.changes);
}

export function readSessionRow(
  db: DatabaseSync,
  conversationId: string,
): StoredSessionRow | undefined {
  const row = db
    .prepare(`
      SELECT conversation_id, scope, workspace_root, created_at, updated_at,
             revision, title, state_json
      FROM sessions
      WHERE conversation_id = ?
    `)
    .get(conversationId) as StoredSessionColumns | undefined;
  if (!row) return undefined;
  try {
    const state = parseSessionStatePayload(JSON.parse(row.state_json) as unknown);
    if (
      state.conversationId !== conversationId ||
      state.snapshot.conversationId !== conversationId
    ) {
      throw new Error("数据库会话 ID 与行不一致");
    }
    return {
      conversationId,
      revision: row.revision,
      state,
      scope: row.scope,
      ...(row.workspace_root === null ? {} : { workspaceRoot: row.workspace_root }),
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  } catch (error) {
    throw new SessionRecordParseError(conversationId, error);
  }
}

export function readSessionRevision(db: DatabaseSync, conversationId: string): number | undefined {
  const row = db
    .prepare("SELECT revision FROM sessions WHERE conversation_id = ?")
    .get(conversationId) as { revision: number } | undefined;
  return row?.revision;
}

export function readSessionSummaryRow(
  db: DatabaseSync,
  conversationId: string,
): SessionListRow | undefined {
  const row = db
    .prepare(`
      SELECT conversation_id, scope, workspace_root, created_at, updated_at,
             title, message_count
      FROM sessions
      WHERE conversation_id = ?
    `)
    .get(conversationId) as StoredSummaryColumns | undefined;
  return row === undefined ? undefined : toSessionListRow(row);
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
  const clauses = ["scope <> 'answer'", "message_count > 0"];
  const parameters: Array<string | number> = [];
  if (filters.scope !== undefined) {
    clauses.push("scope = ?");
    parameters.push(filters.scope);
  }
  if (filters.workspaceRoot !== undefined) {
    const workspaceRoot = workspaceStorageKey(filters.workspaceRoot);
    if (process.platform === "win32") {
      clauses.push("LOWER(workspace_root) = ?");
    } else {
      clauses.push("workspace_root = ?");
    }
    parameters.push(workspaceRoot);
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
             title, message_count
      FROM sessions
      WHERE ${clauses.join(" AND ")}
      ORDER BY updated_at DESC, conversation_id ASC
      LIMIT ?
    `)
    .all(...parameters) as unknown as StoredSummaryColumns[];
  return rows.map(toSessionListRow);
}

function toSessionListRow(row: StoredSummaryColumns): SessionListRow {
  return {
    conversationId: row.conversation_id,
    scope: row.scope,
    ...(row.workspace_root === null ? {} : { workspaceRoot: row.workspace_root }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    title: row.title,
    messageCount: row.message_count,
  };
}

/** 删除会话行时级联删除条目；调用方负责内存视图与调度器。 */
export function deleteSessionRowWithRevision(
  db: DatabaseSync,
  conversationId: string,
  expectedRevision: number,
): number {
  const result = db
    .prepare("DELETE FROM sessions WHERE conversation_id = ? AND revision = ?")
    .run(conversationId, expectedRevision);
  const changes = Number(result.changes);
  if (changes === 1) {
    db.prepare("DELETE FROM session_items WHERE conversation_id = ?").run(conversationId);
  }
  return changes;
}

interface StoredSummaryColumns {
  conversation_id: string;
  scope: ConversationSessionScope;
  workspace_root: string | null;
  created_at: string;
  updated_at: string;
  title: string;
  message_count: number;
}

interface StoredSessionColumns {
  conversation_id: string;
  scope: ConversationSessionScope;
  workspace_root: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
  title: string;
  state_json: string;
}
