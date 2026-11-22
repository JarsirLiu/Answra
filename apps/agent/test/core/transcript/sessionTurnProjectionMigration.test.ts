import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migration } from "../../../src/core/transcript/persistence/sqlite/migration/migrations/20261122130000_session_turn_projection";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("session turn projection migration", () => {
  it("keeps existing turns and replaces the session foreign key with a delete trigger", () => {
    const db = openDatabase();
    const before = readTurns(db);

    migration.up(db);

    expect(readTurns(db)).toEqual(before);
    expect(db.prepare("PRAGMA foreign_key_list(session_turns)").all()).toEqual([]);
    expect(readTriggerNames(db)).toContain("sessions_delete_session_turns");

    db.prepare("DELETE FROM sessions WHERE conversation_id = ?").run("conversation-1");
    expect(readTurns(db)).toEqual([]);
  });
});

function openDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE sessions (conversation_id TEXT PRIMARY KEY);

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
  `);
  db.prepare("INSERT INTO sessions (conversation_id) VALUES (?)").run("conversation-1");
  db.prepare(`
    INSERT INTO session_turns
      (conversation_id, turn_id, seq, source, status, finish_reason, entry_agent_id,
       active_agent_id, input_message_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "conversation-1",
    "turn-1",
    1,
    "user",
    "completed",
    "completed",
    "general",
    "general",
    "message-1",
    "2026-11-22T00:00:00.000Z",
    "2026-11-22T00:00:01.000Z",
  );
  return db;
}

function readTurns(db: DatabaseSync): Record<string, unknown>[] {
  return db
    .prepare(`
      SELECT conversation_id, turn_id, seq, source, status, finish_reason,
             entry_agent_id, active_agent_id, input_message_id,
             origin_session_id, origin_turn_id, origin_agent_id,
             created_at, updated_at
      FROM session_turns
      ORDER BY seq ASC
    `)
    .all() as unknown as Record<string, unknown>[];
}

function readTriggerNames(db: DatabaseSync): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' ORDER BY name ASC")
      .all() as unknown as { name: string }[]
  ).map((row) => row.name);
}
