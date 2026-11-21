import type { DatabaseSync } from "node:sqlite";
import { checksumSql } from "../checksum";
import type { Migration } from "../types";

const DDL = `
ALTER TABLE session_messages ADD COLUMN turn_id TEXT;

CREATE INDEX session_messages_turn
  ON session_messages(conversation_id, turn_id, seq);

CREATE TABLE session_turns (
  conversation_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  finish_reason TEXT,
  entry_agent_id TEXT,
  active_agent_id TEXT,
  input_message_id TEXT,
  origin_session_id TEXT,
  origin_turn_id TEXT,
  origin_agent_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, turn_id),
  UNIQUE (conversation_id, seq),
  FOREIGN KEY (conversation_id) REFERENCES sessions(conversation_id) ON DELETE CASCADE
);
`;

const BACKFILL_VERSION = "session-turn-backfill-v1";

export const migration: Migration = {
  id: "20261121120000_add_session_turns",
  checksum: checksumSql(`${DDL}\n${BACKFILL_VERSION}`),
  up(db) {
    db.exec(DDL);
    backfillTurns(db);
  },
};

interface SessionRow {
  conversation_id: string;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  message_id: string;
  seq: number;
  message_json: string;
}

interface ParsedMessage {
  role?: unknown;
  status?: unknown;
  authorAgentId?: unknown;
}

interface TurnDraft {
  turnId: string;
  seq: number;
  source: "user" | "opening";
  status: "completed" | "failed" | "aborted";
  finishReason?: string;
  entryAgentId?: string;
  activeAgentId?: string;
  inputMessageId?: string;
  createdAt: string;
  updatedAt: string;
  hasAssistant: boolean;
  hasFailed: boolean;
  hasInterrupted: boolean;
  messageIds: string[];
}

function backfillTurns(db: DatabaseSync): void {
  const sessions = db
    .prepare("SELECT conversation_id, created_at, updated_at FROM sessions")
    .all() as unknown as SessionRow[];
  for (const session of sessions) {
    const messages = db
      .prepare(`
        SELECT message_id, seq, message_json
        FROM session_messages
        WHERE conversation_id = ?
        ORDER BY seq ASC
      `)
      .all(session.conversation_id) as unknown as MessageRow[];
    if (messages.length === 0) continue;

    const turns = buildTurns(messages, session);
    insertTurns(db, session.conversation_id, turns);
    assignMessages(db, session.conversation_id, turns);
  }
}

function buildTurns(messages: readonly MessageRow[], session: SessionRow): TurnDraft[] {
  const turns: TurnDraft[] = [];
  let current: TurnDraft | undefined;

  for (const message of messages) {
    const parsed = parseMessage(message);
    if (parsed.role === "user") {
      current = {
        turnId: message.message_id,
        seq: turns.length + 1,
        source: "user",
        status: "completed",
        inputMessageId: message.message_id,
        createdAt: session.created_at,
        updatedAt: session.updated_at,
        hasAssistant: false,
        hasFailed: false,
        hasInterrupted: false,
        messageIds: [],
      };
      turns.push(current);
    } else if (current === undefined) {
      current = {
        turnId: `opening:${message.message_id}`,
        seq: 1,
        source: "opening",
        status: "completed",
        createdAt: session.created_at,
        updatedAt: session.updated_at,
        hasAssistant: false,
        hasFailed: false,
        hasInterrupted: false,
        messageIds: [],
      };
      turns.push(current);
    }

    current.messageIds.push(message.message_id);
    if (parsed.role !== "assistant") continue;

    current.hasAssistant = true;
    const authorAgentId = stringValue(parsed.authorAgentId);
    if (authorAgentId !== undefined) {
      current.entryAgentId ??= authorAgentId;
      current.activeAgentId = authorAgentId;
    }
    const status = stringValue(parsed.status);
    if (status === "failed") current.hasFailed = true;
    if (status === "streaming" || status === "interrupted") current.hasInterrupted = true;
  }

  for (const turn of turns) settleTurn(turn);
  return turns;
}

function settleTurn(turn: TurnDraft): void {
  if (turn.hasFailed) {
    turn.status = "failed";
    turn.finishReason = "unknown";
    return;
  }
  if (turn.hasInterrupted) {
    turn.status = "aborted";
    turn.finishReason = "interrupted";
    return;
  }
  if (!turn.hasAssistant) {
    turn.status = "failed";
    turn.finishReason = "interrupted";
    return;
  }
  turn.status = "completed";
  turn.finishReason = "completed";
}

function insertTurns(db: DatabaseSync, conversationId: string, turns: readonly TurnDraft[]): void {
  const insert = db.prepare(`
    INSERT INTO session_turns
      (conversation_id, turn_id, seq, source, status, finish_reason, entry_agent_id,
       active_agent_id, input_message_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const turn of turns) {
    insert.run(
      conversationId,
      turn.turnId,
      turn.seq,
      turn.source,
      turn.status,
      turn.finishReason ?? null,
      turn.entryAgentId ?? null,
      turn.activeAgentId ?? null,
      turn.inputMessageId ?? null,
      turn.createdAt,
      turn.updatedAt,
    );
  }
}

function assignMessages(
  db: DatabaseSync,
  conversationId: string,
  turns: readonly TurnDraft[],
): void {
  const update = db.prepare(`
    UPDATE session_messages
    SET turn_id = ?
    WHERE conversation_id = ? AND message_id = ?
  `);
  for (const turn of turns) {
    for (const messageId of turn.messageIds) {
      update.run(turn.turnId, conversationId, messageId);
    }
  }
}

function parseMessage(row: MessageRow): ParsedMessage {
  let value: unknown;
  try {
    value = JSON.parse(row.message_json) as unknown;
  } catch (error) {
    throw new Error(
      `消息无法解析，无法回填 turn：${row.message_id}（${
        error instanceof Error ? error.message : String(error)
      }）`,
    );
  }
  if (typeof value !== "object" || value === null) {
    throw new Error(`消息不是对象，无法回填 turn：${row.message_id}`);
  }
  return value as ParsedMessage;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
