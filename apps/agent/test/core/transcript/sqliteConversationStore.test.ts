import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionRecordPayload } from "../../../src/core/transcript/persistence/sessionRecord";
import { MIGRATIONS } from "../../../src/core/transcript/persistence/sqlite/migration/registry.gen";
import {
  ConversationSessionConflictError,
  ConversationSessionCorruptError,
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

/**
 * 测试直写：内存视图 + 用户条目。运行时的 `SessionRuntime` 也是这两步，
 * 但 store 本身只负责 transcript，不会替调用方写条目。
 */
async function appendUser(
  store: SqliteConversationStore,
  conversationId: string,
  message: { id: string; text: string },
): Promise<void> {
  await store.appendUserMessage(conversationId, {
    id: message.id,
    role: "user",
    text: message.text,
    images: [],
    status: "complete",
  });
  await store.items.appendItems(conversationId, [
    {
      itemId: message.id,
      status: "complete",
      createdAt: new Date().toISOString(),
      turnId: message.id,
      payload: { kind: "user", text: message.text, images: [] },
    },
  ]);
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
    await appendUser(store, "coding-1", { id: "user-1", text: "修复登录流程" });

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
    await store.beginSessionTurn("coding-2", {
      turnId: "turn-1",
      messageId: "run-1",
      userMessage: {
        id: "user-1",
        role: "user",
        text: "继续实现",
        images: [],
        status: "complete",
      },
      authorAgentId: "general",
    });
    await store.items.appendItems("coding-2", [
      {
        itemId: "user-1",
        status: "complete",
        createdAt: "2026-11-23T10:00:00.000Z",
        turnId: "turn-1",
        payload: { kind: "user", text: "继续实现", images: [] },
      },
    ]);
    await store.items.beginTurn("coding-2", "turn-1");
    await store.items.appendItems("coding-2", [
      {
        itemId: "run-1:text",
        status: "interrupted",
        createdAt: "2026-11-23T10:00:01.000Z",
        turnId: "turn-1",
        messageId: "run-1",
        authorAgentId: "general",
        payload: { kind: "text", text: "半截实现" },
      },
    ]);

    const reloaded = storeFor(root);
    const snapshot = await reloaded.load("coding-2");
    expect(snapshot.activeMessageId).toBeUndefined();
    expect(snapshot.lastSeq).toBe(2);
    expect(snapshot.messages.map((message) => [message.id, message.status])).toEqual([
      ["user-1", "complete"],
      ["run-1", "interrupted"],
    ]);
  });

  it("derives the durable cursor from the item sequence instead of persisting it", async () => {
    const root = await createRoot();
    const store = storeFor(root);
    await store.create("coding-cursor", undefined, { scope: "coding" });
    await appendUser(store, "coding-cursor", { id: "user-1", text: "继续" });

    const reloaded = storeFor(root);
    expect((await reloaded.load("coding-cursor")).lastSeq).toBe(1);
  });

  it("round-trips the pruning watermark with the context state", async () => {
    const root = await createRoot();
    const store = storeFor(root);
    await store.create("coding-3", undefined, { scope: "coding" });
    await appendUser(store, "coding-3", { id: "user-1", text: "保留上下文" });
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

  it("round-trips retained user messages in the latest checkpoint", async () => {
    const root = await createRoot();
    const store = storeFor(root);
    await store.create("coding-retained", undefined, { scope: "coding" });
    await appendUser(store, "coding-retained", { id: "user-1", text: "保留原始任务" });
    await store.saveContextState("coding-retained", {
      checkpoints: [
        {
          summary: "旧摘要",
          throughMessageId: "user-1",
          createdAt: "2026-11-20T10:00:00.000Z",
          messageCount: 1,
          retainedUserMessages: [
            {
              id: "user-1",
              role: "user",
              text: "保留原始任务",
              images: [],
              status: "complete",
            },
          ],
        },
      ],
    });

    const reloaded = storeFor(root);
    await reloaded.load("coding-retained");

    expect(
      (await reloaded.loadContextState("coding-retained"))?.checkpoints.at(-1)
        ?.retainedUserMessages,
    ).toEqual([
      {
        id: "user-1",
        role: "user",
        text: "保留原始任务",
        images: [],
        status: "complete",
      },
    ]);
  });

  it("lists a corrupt state row without parsing and fails only when opened", async () => {
    const root = await createRoot();
    const store = storeFor(root);
    await store.create("coding-ok", undefined, { scope: "coding" });

    const now = new Date().toISOString();
    const db = new DatabaseSync(path.join(root, "sessions.sqlite"));
    db.prepare(`
      INSERT INTO sessions
        (conversation_id, scope, workspace_root, created_at, updated_at, revision,
         title, message_count, state_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("broken", "coding", null, now, now, 0, "损坏会话", 1, "{");
    db.close();

    expect((await store.list({ scope: "coding" })).items).toHaveLength(1);
    await expect(store.load("broken")).rejects.toBeInstanceOf(ConversationSessionCorruptError);
  });

  it("keeps answer conversations in memory without database rows", async () => {
    const root = await createRoot();
    const store = storeFor(root);
    await store.create("active-exam-conversation", undefined, { scope: "answer" });
    // answer 域不写条目：直接追加内存消息即可。
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

  it("archives a duplicate legacy file as already imported instead of corrupt", async () => {
    const root = await createRoot();
    const store = storeFor(root);
    await store.create("coding-dup", undefined, { scope: "coding" });
    await appendUser(store, "coding-dup", { id: "user-1", text: "已有会话" });
    await store.close();

    const db = new DatabaseSync(path.join(root, "sessions.sqlite"));
    db.prepare("DELETE FROM meta WHERE key LIKE 'legacy-import:%'").run();
    db.close();

    const now = new Date().toISOString();
    await writeFile(
      path.join(root, "coding-dup.json"),
      JSON.stringify({
        schemaVersion: 1,
        conversationId: "coding-dup",
        scope: "coding",
        createdAt: now,
        updatedAt: now,
        snapshot: {
          conversationId: "coding-dup",
          messages: [],
        },
      }),
      "utf8",
    );

    const reloaded = storeFor(root);
    expect((await reloaded.list({ scope: "coding" })).items).toHaveLength(1);
    const archived = await readdir(path.join(root, "legacy"));
    expect(archived).toContain("coding-dup.json");
    expect(archived.some((name) => name.includes(".corrupt-"))).toBe(false);
  });

  it("rejects a stale write instead of overwriting another store", async () => {
    const root = await createRoot();
    const first = storeFor(root);
    await first.create("coding-conflict", undefined, { scope: "coding" });
    await appendUser(first, "coding-conflict", { id: "user-0", text: "初始" });
    const second = storeFor(root);
    await second.load("coding-conflict");

    await appendUser(first, "coding-conflict", { id: "user-1", text: "先写" });

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
      "初始",
      "先写",
    ]);
  });

  it("does not delete the winner's messages when clear loses the revision race", async () => {
    const root = await createRoot();
    const first = storeFor(root);
    await first.create("coding-clear", undefined, { scope: "coding" });
    await appendUser(first, "coding-clear", { id: "user-0", text: "初始" });
    const second = storeFor(root);
    await second.load("coding-clear");

    await appendUser(first, "coding-clear", { id: "user-1", text: "先写" });

    await expect(second.clear("coding-clear")).rejects.toBeInstanceOf(
      ConversationSessionConflictError,
    );
    const db = new DatabaseSync(path.join(root, "sessions.sqlite"));
    expect(db.prepare("SELECT COUNT(*) AS count FROM session_items").get()).toEqual({
      count: 2,
    });
    db.close();
  });

  it("rejects deleting a session changed by another store", async () => {
    const root = await createRoot();
    const first = storeFor(root);
    await first.create("coding-delete", undefined, { scope: "coding" });
    await appendUser(first, "coding-delete", { id: "user-0", text: "初始" });
    const second = storeFor(root);
    await second.load("coding-delete");

    await appendUser(first, "coding-delete", { id: "user-1", text: "先写" });

    await expect(second.delete("coding-delete")).rejects.toBeInstanceOf(
      ConversationSessionConflictError,
    );
    const db = new DatabaseSync(path.join(root, "sessions.sqlite"));
    expect(db.prepare("SELECT COUNT(*) AS count FROM session_items").get()).toEqual({
      count: 2,
    });
    db.close();
    expect((await first.load("coding-delete")).messages.map((message) => message.text)).toEqual([
      "初始",
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
      appendUser(first, "coding-a", { id: "a-user", text: "A" }),
      appendUser(second, "coding-b", { id: "b-user", text: "B" }),
    ]);

    expect((await first.load("coding-a")).messages).toHaveLength(1);
    expect((await second.load("coding-b")).messages).toHaveLength(1);
    expect((await first.list({ scope: "coding" })).items).toHaveLength(2);
  });

  it("initializes a new database with the current migration ledger", async () => {
    const root = await createRoot();
    storeFor(root);

    const db = new DatabaseSync(path.join(root, "sessions.sqlite"));
    try {
      const rows = db.prepare("SELECT id FROM _migrations ORDER BY id ASC").all() as unknown as {
        id: string;
      }[];
      expect(rows.map((row) => row.id)).toEqual(MIGRATIONS.map((migration) => migration.id));
    } finally {
      db.close();
    }
  });

  it("ignores PRAGMA user_version when the migration ledger is current", async () => {
    const root = await createRoot();
    storeFor(root);

    const db = new DatabaseSync(path.join(root, "sessions.sqlite"));
    db.exec("PRAGMA user_version = 99");
    db.close();

    expect(() => storeFor(root)).not.toThrow();
  });

  it("rejects a database created before the migration ledger", async () => {
    const root = await createRoot();
    const db = new DatabaseSync(path.join(root, "sessions.sqlite"));
    db.exec("CREATE TABLE sessions (conversation_id TEXT PRIMARY KEY)");
    db.close();

    expect(() => new SqliteConversationStore(root)).toThrow("pnpm db:reset");
  });

  it("hides an empty session from the list and drops it when cleared", async () => {
    const root = await createRoot();
    const store = storeFor(root);
    await store.create("coding-empty", undefined, { scope: "coding" });

    // 会话行要先存在，条目写入才有游标可更新；列表按 message_count 过滤。
    expect((await store.list({ scope: "coding" })).items).toEqual([]);

    await appendUser(store, "coding-empty", { id: "user-1", text: "第一条消息" });
    expect((await store.list({ scope: "coding" })).items).toHaveLength(1);

    await store.clear("coding-empty");
    expect((await store.list({ scope: "coding" })).items).toEqual([]);
    const verification = new DatabaseSync(path.join(root, "sessions.sqlite"));
    expect(verification.prepare("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({
      count: 0,
    });
    verification.close();

    expect((await store.load("coding-empty")).messages).toEqual([]);
    await appendUser(store, "coding-empty", { id: "user-2", text: "清空后重写" });
    expect((await store.list({ scope: "coding" })).items).toHaveLength(1);
  });

  it("finds a session by exact id without going through the list page", async () => {
    const root = await createRoot();
    const store = storeFor(root);
    await store.create("coding-direct", undefined, {
      scope: "coding",
      workspaceRoot: "D:\\WorkSpace",
    });
    await appendUser(store, "coding-direct", { id: "user-1", text: "直接查找" });

    expect(await store.getSession("coding-direct")).toMatchObject({
      conversationId: "coding-direct",
      title: "直接查找",
      messageCount: 1,
    });
    expect(await store.getSession("coding-direct", "D:\\WorkSpace")).toBeDefined();
    expect(await store.getSession("coding-direct", "E:\\WorkSpace")).toBeUndefined();
    expect(await store.getSession("missing")).toBeUndefined();
  });

  it("matches workspace roots case-insensitively on Windows", async () => {
    if (process.platform !== "win32") return;
    const root = await createRoot();
    const store = storeFor(root);
    await store.create("coding-case", undefined, {
      scope: "coding",
      workspaceRoot: "D:\\WorkSpace",
    });
    await appendUser(store, "coding-case", { id: "user-1", text: "大小写路径" });

    expect(
      (await store.list({ scope: "coding", workspaceRoot: "d:\\workspace" })).items,
    ).toHaveLength(1);
  });

  it("paginates sessions with a stable cursor without duplicates", async () => {
    const root = await createRoot();
    const store = storeFor(root);
    for (const conversationId of ["coding-1", "coding-2", "coding-3", "coding-4", "coding-5"]) {
      await store.create(conversationId, undefined, { scope: "coding" });
      await appendUser(store, conversationId, {
        id: `user-${conversationId}`,
        text: conversationId,
      });
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
