import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migration } from "../../../src/core/transcript/persistence/sqlite/migration/migrations/20261121120000_add_session_turns";

const databases: DatabaseSync[] = [];

const LEGACY_SCHEMA = `
CREATE TABLE sessions (
  conversation_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE session_messages (
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  message_json TEXT NOT NULL,
  PRIMARY KEY (conversation_id, message_id),
  UNIQUE (conversation_id, seq)
);
`;

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("session turn migration", () => {
  it("keeps one turn across handoff messages and preserves message ids", () => {
    const db = openLegacyDatabase();
    insertSession(db, "conversation-1");
    insertMessage(db, "conversation-1", 1, "user", "complete", "message-1");
    insertMessage(db, "conversation-1", 2, "assistant", "complete", "run-1", "general");
    insertMessage(db, "conversation-1", 3, "assistant", "complete", "handoff-1", "general");
    insertMessage(db, "conversation-1", 4, "assistant", "complete", "run-2", "intake");

    migration.up(db);

    expect(readMessageTurns(db, "conversation-1")).toEqual([
      ["message-1", "message-1"],
      ["run-1", "message-1"],
      ["handoff-1", "message-1"],
      ["run-2", "message-1"],
    ]);
    expect(readTurns(db, "conversation-1")).toEqual([
      {
        turn_id: "message-1",
        seq: 1,
        source: "user",
        status: "completed",
        finish_reason: "completed",
        entry_agent_id: "general",
        active_agent_id: "intake",
        input_message_id: "message-1",
      },
    ]);
  });

  it("creates a deterministic opening turn and marks interrupted turns", () => {
    const db = openLegacyDatabase();
    insertSession(db, "conversation-1");
    insertMessage(db, "conversation-1", 1, "assistant", "complete", "opening-run", "intake");
    insertSession(db, "conversation-2");
    insertMessage(db, "conversation-2", 1, "user", "complete", "message-2");
    insertMessage(db, "conversation-2", 2, "assistant", "streaming", "run-3", "general");
    insertSession(db, "conversation-3");
    insertMessage(db, "conversation-3", 1, "user", "complete", "message-3");
    insertMessage(db, "conversation-3", 2, "assistant", "failed", "run-4", "general");

    migration.up(db);

    expect(readTurns(db, "conversation-1")[0]).toMatchObject({
      turn_id: "opening:opening-run",
      source: "opening",
      status: "completed",
      finish_reason: "completed",
      input_message_id: null,
    });
    expect(readTurns(db, "conversation-2")[0]).toMatchObject({
      turn_id: "message-2",
      status: "aborted",
      finish_reason: "interrupted",
    });
    expect(readTurns(db, "conversation-3")[0]).toMatchObject({
      turn_id: "message-3",
      status: "failed",
      finish_reason: "unknown",
    });
  });

  it("does not create turns for an empty session", () => {
    const db = openLegacyDatabase();
    insertSession(db, "conversation-1");

    migration.up(db);

    expect(readTurns(db, "conversation-1")).toEqual([]);
  });
});

function openLegacyDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(LEGACY_SCHEMA);
  return db;
}

function insertSession(db: DatabaseSync, conversationId: string): void {
  db.prepare(`
    INSERT INTO sessions (conversation_id, created_at, updated_at)
    VALUES (?, ?, ?)
  `).run(conversationId, "2026-11-20T00:00:00.000Z", "2026-11-20T00:00:01.000Z");
}

function insertMessage(
  db: DatabaseSync,
  conversationId: string,
  seq: number,
  role: "user" | "assistant",
  status: string,
  id: string,
  authorAgentId?: string,
): void {
  const message = {
    id,
    role,
    text: id,
    images: [],
    status,
    ...(authorAgentId === undefined ? {} : { authorAgentId }),
  };
  db.prepare(`
    INSERT INTO session_messages
      (conversation_id, message_id, seq, role, status, message_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(conversationId, id, seq, role, status, JSON.stringify(message));
}

function readMessageTurns(db: DatabaseSync, conversationId: string): [string, string][] {
  const rows = db
    .prepare(`
      SELECT message_id, turn_id
      FROM session_messages
      WHERE conversation_id = ?
      ORDER BY seq ASC
    `)
    .all(conversationId) as unknown as { message_id: string; turn_id: string }[];
  return rows.map((row) => [row.message_id, row.turn_id]);
}

function readTurns(db: DatabaseSync, conversationId: string): Record<string, unknown>[] {
  return db
    .prepare(`
      SELECT turn_id, seq, source, status, finish_reason, entry_agent_id,
             active_agent_id, input_message_id
      FROM session_turns
      WHERE conversation_id = ?
      ORDER BY seq ASC
    `)
    .all(conversationId) as unknown as Record<string, unknown>[];
}
