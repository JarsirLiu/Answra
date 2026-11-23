/**
 * P4 升级路径：一个「发布过的旧库」只靠真实 migration 链升到只剩
 * `sessions` + `session_items`，且旧消息已折叠、条目级联删除仍然成立。
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ConversationMessage } from "@answra/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureMigrationLedger,
  recordMigration,
} from "../../../src/core/transcript/persistence/sqlite/migration/ledger";
import { MIGRATIONS } from "../../../src/core/transcript/persistence/sqlite/migration/registry.gen";
import { SqliteConversationStore } from "../../../src/core/transcript/persistence/sqlite/sqliteConversationStore";
import { PREVIOUS_SESSION_SCHEMA_SQL } from "./legacySessionSchemaFixture";

const SESSION = "legacy-upgrade";
const AT = "2026-11-23T10:00:00.000Z";
const FIRST_ITEMS_MIGRATION_ID = "20261123120000_session_items";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("legacy session table drop migration", () => {
  it("upgrades a released database to the two-table schema and keeps folded content", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "answra-session-upgrade-"));
    roots.push(root);
    const filePath = path.join(root, "sessions.sqlite");
    seedReleasedDatabase(filePath);

    const store = new SqliteConversationStore(root);
    try {
      const snapshot = await store.load(SESSION);
      expect(snapshot.messages.map((message) => [message.id, message.text])).toEqual([
        ["m-u1", "旧库消息"],
        ["m-a1", "旧库回答"],
      ]);
      expect(snapshot.lastSeq).toBe(3);

      const db = new DatabaseSync(filePath);
      try {
        expect(listObjects(db, "table")).toEqual(["_migrations", "session_items", "sessions"]);
        expect(listObjects(db, "trigger")).toEqual([]);
        expect(columnNames(db, "sessions")).not.toContain("revision");
        expect(
          db
            .prepare(
              `SELECT next_seq, message_count, open_turn_id, created_at, updated_at
               FROM sessions WHERE conversation_id = ?`,
            )
            .get(SESSION),
        ).toEqual({
          next_seq: 4,
          message_count: 2,
          open_turn_id: null,
          created_at: AT,
          updated_at: AT,
        });
        expect(db.prepare("SELECT COUNT(*) AS count FROM session_items").get()).toEqual({
          count: 3,
        });
      } finally {
        db.close();
      }

      await store.delete(SESSION);
      const verification = new DatabaseSync(filePath);
      try {
        expect(verification.prepare("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({
          count: 0,
        });
        expect(verification.prepare("SELECT COUNT(*) AS count FROM session_items").get()).toEqual({
          count: 0,
        });
      } finally {
        verification.close();
      }
    } finally {
      await store.close();
    }
  });
});

/** 模拟发布过的旧库：旧 schema + 账本只记到 `session_items` 之前。 */
function seedReleasedDatabase(filePath: string): void {
  const db = new DatabaseSync(filePath);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(PREVIOUS_SESSION_SCHEMA_SQL);
    ensureMigrationLedger(db);
    const released = MIGRATIONS.filter((migration) => migration.id < FIRST_ITEMS_MIGRATION_ID);
    expect(released.length).toBeGreaterThan(0);
    for (const migration of released) recordMigration(db, migration, 1);

    db.prepare(`
      INSERT INTO sessions
        (conversation_id, scope, workspace_root, created_at, updated_at, revision,
         title, message_count, state_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      SESSION,
      "coding",
      null,
      AT,
      AT,
      7,
      "旧库会话",
      2,
      JSON.stringify({
        schemaVersion: 1,
        conversationId: SESSION,
        snapshot: { conversationId: SESSION },
      }),
    );
    insertStoredMessage(db, 1, {
      id: "m-u1",
      role: "user",
      audience: { kind: "user" },
      text: "旧库消息",
      images: [],
      status: "complete",
      parts: [],
    });
    insertStoredMessage(db, 2, {
      id: "m-a1",
      role: "assistant",
      authorAgentId: "general",
      audience: { kind: "user" },
      text: "旧库回答",
      images: [],
      status: "complete",
      parts: [{ id: "t-1", kind: "text", text: "旧库回答", state: "completed" }],
    });
  } finally {
    db.close();
  }
}

function insertStoredMessage(db: DatabaseSync, seq: number, message: ConversationMessage): void {
  db.prepare(`
    INSERT INTO session_messages
      (conversation_id, message_id, turn_id, seq, role, status, message_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(SESSION, message.id, null, seq, message.role, message.status, JSON.stringify(message));
}

function listObjects(db: DatabaseSync, type: "table" | "trigger"): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_schema WHERE type = ? ORDER BY name ASC")
      .all(type) as unknown as { name: string }[]
  ).map((row) => row.name);
}

function columnNames(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map(
    (row) => row.name,
  );
}
