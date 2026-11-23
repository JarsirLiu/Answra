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

/**
 * 写入会话元数据与 `state_json`。已存在的会话只更新这两类字段；`updated_at` /
 * `message_count` / `next_seq` / `open_turn_id` 由条目写入维护，不被本函数覆盖。
 */
export function writeSessionRow(db: DatabaseSync, input: SessionRowInput): number {
  const result = db
    .prepare(`
      INSERT INTO sessions
        (conversation_id, scope, workspace_root, created_at, updated_at,
         title, message_count, state_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        scope = excluded.scope,
        workspace_root = excluded.workspace_root,
        title = excluded.title,
        state_json = excluded.state_json
    `)
    .run(
      input.state.conversationId,
      input.scope,
      input.workspaceRoot ?? null,
      input.createdAt,
      input.updatedAt,
      input.title,
      input.messageCount,
      JSON.stringify(input.state),
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
             title, state_json
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

/** 删除会话行；不处理条目（调用方在同一事务内先清理）。 */
export function deleteSessionRow(db: DatabaseSync, conversationId: string): number {
  const result = db.prepare("DELETE FROM sessions WHERE conversation_id = ?").run(conversationId);
  return Number(result.changes);
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
  title: string;
  state_json: string;
}
