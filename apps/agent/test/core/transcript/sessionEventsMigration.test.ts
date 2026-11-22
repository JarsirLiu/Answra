import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migration } from "../../../src/core/transcript/persistence/sqlite/migration/migrations/20261122120000_add_session_events";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("session events migration", () => {
  it("creates an append-only event table and clears events with the session", () => {
    const db = openDatabase();
    migration.up(db);

    db.prepare("INSERT INTO sessions (conversation_id) VALUES (?)").run("conversation-1");
    insertEvent(db, 1, "event-1");
    insertEvent(db, 2, "event-2");

    expect(readEventIds(db)).toEqual(["event-1", "event-2"]);
    expect(() => insertEvent(db, 1, "event-duplicate")).toThrow(/UNIQUE/i);
    expect(() => insertEvent(db, 3, "event-1")).toThrow(/UNIQUE/i);

    db.prepare("DELETE FROM sessions WHERE conversation_id = ?").run("conversation-1");
    expect(readEventIds(db)).toEqual([]);
  });
});

function openDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("CREATE TABLE sessions (conversation_id TEXT PRIMARY KEY)");
  return db;
}

function insertEvent(db: DatabaseSync, seq: number, eventId: string): void {
  db.prepare(`
    INSERT INTO session_events
      (conversation_id, seq, event_id, producer_id, occurred_at, event_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("conversation-1", seq, eventId, "answra-agent", "2026-11-22T00:00:00.000Z", "{}");
}

function readEventIds(db: DatabaseSync): string[] {
  return (
    db.prepare("SELECT event_id FROM session_events ORDER BY seq ASC").all() as unknown as {
      event_id: string;
    }[]
  ).map((row) => row.event_id);
}
