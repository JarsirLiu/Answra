import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionRecordPayload } from "../../../src/core/transcript/persistence/sessionRecord";
import {
  ConversationSessionConflictError,
  SqliteConversationStore,
} from "../../../src/core/transcript/persistence/sqlite/sqliteConversationStore";

const roots: string[] = [];
const stores: SqliteConversationStore[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "answra-session-sqlite-"));
  roots.push(root);
  return root;
}

function storeFor(root: string): SqliteConversationStore {
  const store = new SqliteConversationStore(root);
  stores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SQLite conversation store", () => {
  it("round-trips a session, lists its summary and deletes it", async () => {
    const root = await createRoot();
    const store = storeFor(root);
    await store.create("coding-1", undefined, {
      scope: "coding",
      workspaceRoot: "D:\\workspace",
    });
    await store.appendUserMessage("coding-1", {
      id: "user-1",
      role: "user",
      text: "修复登录流程",
      images: [],
      status: "complete",
    });

    const reloaded = storeFor(root);
    const snapshot = await reloaded.load("coding-1");
    expect(snapshot.messages.map((message) => message.text)).toEqual(["修复登录流程"]);

    const summaries = (await reloaded.list({ scope: "coding", workspaceRoot: "D:\\workspace" }))
      .items;
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      conversationId: "coding-1",
      scope: "coding",
      title: "修复登录流程",
      messageCount: 1,
      workspaceRoot: "D:\\workspace",
    });

    await reloaded.delete("coding-1");
    await expect(reloaded.load("coding-1")).rejects.toThrow("会话不存在");
    expect((await reloaded.list({ scope: "coding" })).items).toEqual([]);
  });

  it("restores an unfinished run as interrupted without an active run", async () => {
    const root = await createRoot();
    const store = storeFor(root);
    await store.create("coding-2", undefined, { scope: "coding" });
    await store.beginRun(
      "coding-2",
      "run-1",
      {
        id: "user-1",
        role: "user",
        text: "继续实现",
        images: [],
        status: "complete",
      },
      3,
    );

    const reloaded = storeFor(root);
    const snapshot = await reloaded.load("coding-2");
    expect(snapshot.activeRunId).toBeUndefined();
    expect(snapshot.eventRevision).toBe(0);
    expect(snapshot.messages.map((message) => [message.id, message.status])).toEqual([
      ["user-1", "complete"],
      ["run-1", "interrupted"],
    ]);
  });

  it("round-trips the pruning watermark with the context state", async () => {
    const root = await createRoot();
    const store = storeFor(root);
    await store.create("coding-3", undefined, { scope: "coding" });
    await store.saveContextState("coding-3", {
      checkpoints: [],
      prunedToolCallIds: ["call-1", "call-2"],
    });

    const reloaded = storeFor(root);
    await reloaded.load("coding-3");

    expect(await reloaded.loadContextState("coding-3")).toMatchObject({
      prunedToolCallIds: ["call-1", "call-2"],
    });
  });

  it("quarantines a corrupt row and keeps listing other sessions", async () => {
    const root = await createRoot();
    const store = storeFor(root);
    await store.create("coding-ok", undefined, { scope: "coding" });

    const now = new Date().toISOString();
    const db = new DatabaseSync(path.join(root, "sessions.sqlite"));
    db.prepare(`
      INSERT INTO sessions
        (conversation_id, scope, workspace_root, created_at, updated_at, revision, record_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("broken", "coding", null, now, now, 0, "{");
    db.close();

    expect((await store.list({ scope: "coding" })).items).toHaveLength(1);

    const verification = new DatabaseSync(path.join(root, "sessions.sqlite"));
    const quarantined = verification
      .prepare("SELECT reason FROM quarantined_sessions WHERE conversation_id = ?")
      .get("broken") as { reason: string } | undefined;
    verification.close();
    expect(quarantined?.reason).toContain("无法解析");
  });

  it("keeps answer conversations in memory without database rows", async () => {
    const root = await createRoot();
    const store = storeFor(root);
    await store.create("active-exam-conversation", undefined, { scope: "answer" });
    await store.appendUserMessage("active-exam-conversation", {
      id: "user-1",
      role: "user",
      text: "这道题怎么做",
      images: [],
      status: "complete",
    });

    expect((await store.load("active-exam-conversation")).messages).toHaveLength(1);
    expect((await store.list()).items).toEqual([]);
    const db = new DatabaseSync(path.join(root, "sessions.sqlite"));
    expect(db.prepare("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({ count: 0 });
    db.close();
  });

  it("rejects a persisted conversation opened under another scope", async () => {
    const root = await createRoot();
    const store = storeFor(root);
    await store.create("coding-1", undefined, { scope: "coding" });

    await expect(store.create("coding-1", undefined, { scope: "conversation" })).rejects.toThrow(
      "会话 scope 不匹配",
    );
  });

  it("imports legacy JSON sessions once and archives the files", async () => {
    const root = await createRoot();
    const now = new Date().toISOString();
    const legacy: SessionRecordPayload = {
      schemaVersion: 1,
      conversationId: "coding-legacy",
      scope: "coding",
      createdAt: now,
      updatedAt: now,
      snapshot: {
        conversationId: "coding-legacy",
        eventRevision: 0,
        messages: [
          {
            id: "user-1",
            role: "user",
            text: "旧会话",
            images: [],
            status: "complete",
          },
        ],
      },
    };
    await writeFile(path.join(root, "coding-legacy.json"), JSON.stringify(legacy), "utf8");

    const store = storeFor(root);
    expect((await store.load("coding-legacy")).messages[0]?.text).toBe("旧会话");
    expect((await store.list({ scope: "coding" })).items).toHaveLength(1);
    expect(await readdir(path.join(root, "legacy"))).toContain("coding-legacy.json");

    const reloaded = storeFor(root);
    expect((await reloaded.list({ scope: "coding" })).items).toHaveLength(1);
  });

  it("archives a corrupt legacy JSON file without blocking startup", async () => {
    const root = await createRoot();
    await writeFile(path.join(root, "broken.json"), "{", "utf8");

    const store = storeFor(root);
    expect((await store.list({ scope: "coding" })).items).toEqual([]);
    expect(await readdir(path.join(root, "legacy"))).toContainEqual(
      expect.stringMatching(/^broken\.json\.corrupt-\d+$/),
    );
  });

  it("rejects a stale write instead of overwriting another store", async () => {
    const root = await createRoot();
    const first = storeFor(root);
    await first.create("coding-conflict", undefined, { scope: "coding" });
    const second = storeFor(root);
    await second.load("coding-conflict");

    await first.appendUserMessage("coding-conflict", {
      id: "user-1",
      role: "user",
      text: "先写",
      images: [],
      status: "complete",
    });

    await expect(
      second.appendUserMessage("coding-conflict", {
        id: "user-2",
        role: "user",
        text: "后写",
        images: [],
        status: "complete",
      }),
    ).rejects.toBeInstanceOf(ConversationSessionConflictError);
    expect((await second.load("coding-conflict")).messages.map((message) => message.text)).toEqual([
      "先写",
    ]);
  });

  it("writes different sessions in parallel without conflicts", async () => {
    const root = await createRoot();
    const first = storeFor(root);
    const second = storeFor(root);
    await first.create("coding-a", undefined, { scope: "coding", workspaceRoot: "A" });
    await second.create("coding-b", undefined, { scope: "coding", workspaceRoot: "B" });

    await Promise.all([
      first.appendUserMessage("coding-a", {
        id: "a-user",
        role: "user",
        text: "A",
        images: [],
        status: "complete",
      }),
      second.appendUserMessage("coding-b", {
        id: "b-user",
        role: "user",
        text: "B",
        images: [],
        status: "complete",
      }),
    ]);

    expect((await first.load("coding-a")).messages).toHaveLength(1);
    expect((await second.load("coding-b")).messages).toHaveLength(1);
    expect((await first.list({ scope: "coding" })).items).toHaveLength(2);
  });

  it("migrates v1 rows and backfills list summaries", async () => {
    const root = await createRoot();
    const dbPath = path.join(root, "sessions.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE sessions (
        conversation_id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        workspace_root TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE quarantined_sessions (
        conversation_id TEXT NOT NULL,
        record_json TEXT,
        reason TEXT NOT NULL,
        quarantined_at TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `);
    const payload = {
      schemaVersion: 1,
      conversationId: "coding-v1",
      scope: "coding",
      createdAt: "2026-11-17T00:00:00.000Z",
      updatedAt: "2026-11-17T01:00:00.000Z",
      snapshot: {
        conversationId: "coding-v1",
        eventRevision: 0,
        messages: [
          {
            id: "user-v1",
            role: "user",
            text: "旧版本会话",
            images: [],
            status: "complete",
          },
        ],
      },
    };
    db.prepare(`
      INSERT INTO sessions
        (conversation_id, scope, workspace_root, created_at, updated_at, revision, record_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "coding-v1",
      "coding",
      null,
      payload.createdAt,
      payload.updatedAt,
      0,
      JSON.stringify(payload),
    );
    db.close();

    const store = storeFor(root);
    const page = await store.list({ scope: "coding" });
    expect(page.items).toEqual([
      expect.objectContaining({
        conversationId: "coding-v1",
        title: "旧版本会话",
        messageCount: 1,
      }),
    ]);
  });

  it("paginates sessions with a stable cursor without duplicates", async () => {
    const root = await createRoot();
    const store = storeFor(root);
    for (const conversationId of ["coding-1", "coding-2", "coding-3", "coding-4", "coding-5"]) {
      await store.create(conversationId, undefined, { scope: "coding" });
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    const first = await store.list({ scope: "coding", limit: 2 });
    expect(first.items.map((item) => item.conversationId)).toEqual(["coding-5", "coding-4"]);
    expect(first.nextCursor).toBeDefined();
    if (first.nextCursor === undefined) throw new Error("缺少第一页游标");

    const second = await store.list({
      scope: "coding",
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items.map((item) => item.conversationId)).toEqual(["coding-3", "coding-2"]);
    expect(second.nextCursor).toBeDefined();
    if (second.nextCursor === undefined) throw new Error("缺少第二页游标");

    const third = await store.list({ scope: "coding", limit: 2, cursor: second.nextCursor });
    expect(third.items.map((item) => item.conversationId)).toEqual(["coding-1"]);
    expect(third.nextCursor).toBeUndefined();

    const allIds = new Set(
      [...first.items, ...second.items, ...third.items].map((item) => item.conversationId),
    );
    expect(allIds.size).toBe(5);
  });

  it("rejects malformed cursors", async () => {
    const root = await createRoot();
    const store = storeFor(root);
    await expect(store.list({ scope: "coding", cursor: "not-a-cursor" })).rejects.toThrow(
      "会话游标无效",
    );
  });
});
