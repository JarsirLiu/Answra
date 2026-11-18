/** sessions / session_messages / session_message_drafts 的行读写与解析边界；不包含业务状态机。 */
import type { DatabaseSync } from "node:sqlite";
import type { ConversationMessage, ConversationSessionScope } from "@answra/shared";
import type { SessionStatePayload } from "../sessionRecord";
import { parseSessionStatePayload, parseStoredMessage } from "../sessionRecord";
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

export interface StoredMessageRow {
  seq: number;
  message: ConversationMessage;
}

export interface StoredDraftRow {
  messageId: string;
  baseRevision: number;
  draft: ConversationMessage;
}

export interface StoredSessionRow {
  conversationId: string;
  revision: number;
  state: SessionStatePayload;
  messages: StoredMessageRow[];
  drafts: StoredDraftRow[];
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
  const result = db
    .prepare(`
      UPDATE sessions
      SET scope = ?, workspace_root = ?, created_at = ?, updated_at = ?,
          revision = ?, title = ?, message_count = ?, state_json = ?
      WHERE conversation_id = ? AND revision = ?
    `)
    .run(
      input.scope,
      input.workspaceRoot ?? null,
      input.createdAt,
      input.updatedAt,
      expectedRevision + 1,
      input.title,
      input.messageCount,
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
    const messages = listMessageRows(db, conversationId);
    const drafts = listDraftRows(db, conversationId);
    return {
      conversationId,
      revision: row.revision,
      state,
      messages,
      drafts,
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

export function listMessageRows(db: DatabaseSync, conversationId: string): StoredMessageRow[] {
  const rows = db
    .prepare(`
      SELECT seq, message_json
      FROM session_messages
      WHERE conversation_id = ?
      ORDER BY seq ASC
    `)
    .all(conversationId) as Array<{ seq: number; message_json: string }>;
  const ids = new Set<string>();
  return rows.map((row) => {
    const message = parseStoredMessage(JSON.parse(row.message_json) as unknown);
    if (ids.has(message.id)) throw new Error(`消息 ID 重复：${message.id}`);
    ids.add(message.id);
    return { seq: row.seq, message };
  });
}

export function listDraftRows(db: DatabaseSync, conversationId: string): StoredDraftRow[] {
  const rows = db
    .prepare(`
      SELECT message_id, base_revision, draft_json
      FROM session_message_drafts
      WHERE conversation_id = ?
      ORDER BY message_id ASC
    `)
    .all(conversationId) as Array<{
    message_id: string;
    base_revision: number;
    draft_json: string;
  }>;
  return rows.map((row) => {
    const draft = parseStoredMessage(JSON.parse(row.draft_json) as unknown);
    if (draft.id !== row.message_id) throw new Error("消息草稿 ID 与行不一致");
    if (draft.role !== "assistant") throw new Error("消息草稿必须是 assistant 消息");
    return { messageId: row.message_id, baseRevision: row.base_revision, draft };
  });
}

export function insertMessageRow(
  db: DatabaseSync,
  conversationId: string,
  seq: number,
  message: ConversationMessage,
): void {
  db.prepare(`
    INSERT INTO session_messages
      (conversation_id, message_id, seq, role, status, message_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(conversationId, message.id, seq, message.role, message.status, JSON.stringify(message));
}

export function updateMessageRow(
  db: DatabaseSync,
  conversationId: string,
  message: ConversationMessage,
): void {
  db.prepare(`
    UPDATE session_messages
    SET role = ?, status = ?, message_json = ?
    WHERE conversation_id = ? AND message_id = ?
  `).run(message.role, message.status, JSON.stringify(message), conversationId, message.id);
}

export function upsertDraftRow(
  db: DatabaseSync,
  conversationId: string,
  message: ConversationMessage,
  baseRevision: number,
  updatedAt: string,
): void {
  db.prepare(`
    INSERT INTO session_message_drafts
      (conversation_id, message_id, base_revision, draft_json, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id, message_id) DO UPDATE SET
      base_revision = excluded.base_revision,
      draft_json = excluded.draft_json,
      updated_at = excluded.updated_at
  `).run(conversationId, message.id, baseRevision, JSON.stringify(message), updatedAt);
}

export function deleteDraftRow(db: DatabaseSync, conversationId: string, messageId: string): void {
  db.prepare(`
    DELETE FROM session_message_drafts
    WHERE conversation_id = ? AND message_id = ?
  `).run(conversationId, messageId);
}

export function deleteDraftRows(db: DatabaseSync, conversationId: string): void {
  db.prepare("DELETE FROM session_message_drafts WHERE conversation_id = ?").run(conversationId);
}

export function deleteMessageRows(db: DatabaseSync, conversationId: string): void {
  db.prepare("DELETE FROM session_messages WHERE conversation_id = ?").run(conversationId);
}

export function readSessionRevision(db: DatabaseSync, conversationId: string): number | undefined {
  const row = db
    .prepare("SELECT revision FROM sessions WHERE conversation_id = ?")
    .get(conversationId) as { revision: number } | undefined;
  return row?.revision;
}

export function bumpSessionRevision(
  db: DatabaseSync,
  conversationId: string,
  expectedRevision: number,
): number {
  const result = db
    .prepare(
      "UPDATE sessions SET revision = revision + 1 WHERE conversation_id = ? AND revision = ?",
    )
    .run(conversationId, expectedRevision);
  return Number(result.changes);
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
    deleteDraftRows(db, conversationId);
    deleteMessageRows(db, conversationId);
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
