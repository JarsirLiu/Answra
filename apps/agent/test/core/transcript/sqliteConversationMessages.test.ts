import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentStreamEvent } from "@answra/shared/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConversationSessionConflictError,
  ConversationSessionCorruptError,
  SqliteConversationStore,
} from "../../../src/core/transcript/persistence/sqlite/sqliteConversationStore";

const roots: string[] = [];
const stores: SqliteConversationStore[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "answra-session-messages-"));
  roots.push(root);
  return root;
}

function storeFor(root: string): SqliteConversationStore {
  const store = new SqliteConversationStore(root);
  stores.push(store);
  return store;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function startAssistantMessage(
  store: SqliteConversationStore,
  conversationId: string,
  messageId: string,
  userMessageId: string,
): Promise<void> {
  await store.beginSessionTurn(conversationId, {
    turnId: `turn-${messageId}`,
    messageId,
    authorAgentId: "general",
    userMessage: {
      id: userMessageId,
      role: "user",
      text: "question",
      images: [],
      status: "complete",
    },
  });
}

function writeStreamEvent(
  store: SqliteConversationStore,
  conversationId: string,
  messageId: string,
  event: AgentStreamEvent,
): Promise<void> {
  return store.applySessionStreamEvent(conversationId, messageId, event);
}

function readRows(root: string): Array<{
  message_id: string;
  seq: number;
  status: string;
  message_json: string;
}> {
  const db = new DatabaseSync(path.join(root, "sessions.sqlite"));
  const rows = db
    .prepare(`
      SELECT message_id, seq, status, message_json
      FROM session_messages
      ORDER BY seq ASC
    `)
    .all() as unknown as Array<{
    message_id: string;
    seq: number;
    status: string;
    message_json: string;
  }>;
  db.close();
  return rows;
}

function readDraftCount(root: string): number {
  const db = new DatabaseSync(path.join(root, "sessions.sqlite"));
  const row = db.prepare("SELECT COUNT(*) AS count FROM session_message_drafts").get() as {
    count: number;
  };
  db.close();
  return row.count;
}

function readSessionRevision(root: string): { revision: number; updated_at: string } {
  const db = new DatabaseSync(path.join(root, "sessions.sqlite"));
  const row = db
    .prepare("SELECT revision, updated_at FROM sessions WHERE conversation_id = ?")
    .get("coding-1") as { revision: number; updated_at: string };
  db.close();
  return row;
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

describe("SQLite conversation message rows", () => {
  it("writes only dirty message rows and clears or deletes them with the session", async () => {
    const root = await createRoot();
    const store = storeFor(root);
    await store.create("coding-1", undefined, { scope: "coding" });
    await store.appendUserMessage("coding-1", {
      id: "user-1",
      role: "user",
      text: "first",
      images: [],
      status: "complete",
    });
    await startAssistantMessage(store, "coding-1", "run-1", "user-2");

    expect(readRows(root).map((row) => [row.message_id, row.seq])).toEqual([
      ["user-1", 1],
      ["user-2", 2],
      ["run-1", 3],
    ]);

    await store.finishSessionAssistant("coding-1", "run-1", "completed");
    await store.finishSessionTurn("coding-1", "turn-run-1");
    expect(readRows(root).map((row) => [row.message_id, row.status])).toEqual([
      ["user-1", "complete"],
      ["user-2", "complete"],
      ["run-1", "complete"],
    ]);

    await store.clear("coding-1");
    expect(readRows(root)).toEqual([]);
    expect(readDraftCount(root)).toBe(0);

    await store.appendUserMessage("coding-1", {
      id: "user-3",
      role: "user",
      text: "third",
      images: [],
      status: "complete",
    });
    expect(readRows(root).map((row) => [row.message_id, row.seq])).toEqual([["user-3", 1]]);

    await store.delete("coding-1");
    expect(readRows(root)).toEqual([]);
  });

  it("retries messages left unpersisted by a failed transaction", async () => {
    const root = await createRoot();
    const store = storeFor(root);
    await store.create("coding-1", undefined, { scope: "coding" });
    await store.appendUserMessage("coding-1", {
      id: "user-1",
      role: "user",
      text: "first",
      images: [],
      status: "complete",
    });

    const db = new DatabaseSync(path.join(root, "sessions.sqlite"));
    db.exec(`
      CREATE TRIGGER reject_poison BEFORE INSERT ON session_messages
      WHEN NEW.message_id = 'user-poison'
      BEGIN
        SELECT RAISE(ABORT, 'poison');
      END;
    `);
    db.close();

    await expect(
      store.appendUserMessage("coding-1", {
        id: "user-poison",
        role: "user",
        text: "poison",
        images: [],
        status: "complete",
      }),
    ).rejects.toThrow();

    const repair = new DatabaseSync(path.join(root, "sessions.sqlite"));
    repair.exec("DROP TRIGGER reject_poison");
    repair.close();

    await store.appendUserMessage("coding-1", {
      id: "user-2",
      role: "user",
      text: "after",
      images: [],
      status: "complete",
    });

    const reloaded = storeFor(root);
    expect((await reloaded.load("coding-1")).messages.map((message) => message.text)).toEqual([
      "first",
      "poison",
      "after",
    ]);
  });

  it("restores the in-memory session when starting a run fails to persist", async () => {
    const root = await createRoot();
    const store = storeFor(root);
    await store.create("coding-1", undefined, { scope: "coding" });
    await store.appendUserMessage("coding-1", {
      id: "user-0",
      role: "user",
      text: "before",
      images: [],
      status: "complete",
    });

    const db = new DatabaseSync(path.join(root, "sessions.sqlite"));
    db.exec(`
      CREATE TRIGGER reject_run BEFORE INSERT ON session_messages
      WHEN NEW.message_id = 'run-1'
      BEGIN
        SELECT RAISE(ABORT, 'reject run');
      END;
    `);
    db.close();

    await expect(
      startAssistantMessage(store, "coding-1", "run-1", "user-1"),
    ).rejects.toThrow();

    const repair = new DatabaseSync(path.join(root, "sessions.sqlite"));
    repair.exec("DROP TRIGGER reject_run");
    repair.close();

    const restored = await store.load("coding-1");
    expect(restored.activeMessageId).toBeUndefined();
    expect(restored.messages.map((message) => message.id)).toEqual(["user-0"]);

    await store.appendUserMessage("coding-1", {
      id: "user-2",
      role: "user",
      text: "after",
      images: [],
      status: "complete",
    });
    expect((await store.load("coding-1")).messages.map((message) => message.id)).toEqual([
      "user-0",
      "user-2",
    ]);
  });

  it("checkpoints streaming text on the timer without moving the session revision", async () => {
    vi.useFakeTimers();
    const root = await createRoot();
    const store = storeFor(root);
    await store.create("coding-1", undefined, { scope: "coding" });
    await startAssistantMessage(store, "coding-1", "run-1", "user-1");
    const before = readSessionRevision(root);

    await writeStreamEvent(
      store,
      "coding-1",
      "run-1",
      {
        type: "text-delta",
        partId: "text-1",
        delta: "partial",
      },
    );
    await writeStreamEvent(
      store,
      "coding-1",
      "run-1",
      {
        type: "reasoning-delta",
        partId: "reason-1",
        delta: "thinking",
      },
    );

    expect(vi.getTimerCount()).toBe(1);
    expect(readDraftCount(root)).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();
    expect(readDraftCount(root)).toBe(1);
    expect(readSessionRevision(root)).toEqual(before);

    await writeStreamEvent(
      store,
      "coding-1",
      "run-1",
      {
        type: "text-end",
        partId: "text-1",
      },
    );
    await flushMicrotasks();
    expect(readDraftCount(root)).toBe(1);

    await store.finishSessionAssistant("coding-1", "run-1", "completed");
    await store.finishSessionTurn("coding-1", "turn-run-1");
    expect(readDraftCount(root)).toBe(0);
    expect(readRows(root).find((row) => row.message_id === "run-1")?.status).toBe("complete");
  });

  it("flushes immediately once a streaming message grows past two kilobytes", async () => {
    const root = await createRoot();
    const store = storeFor(root);
    await store.create("coding-1", undefined, { scope: "coding" });
    await startAssistantMessage(store, "coding-1", "run-1", "user-1");

    await writeStreamEvent(
      store,
      "coding-1",
      "run-1",
      {
        type: "text-delta",
        partId: "text-1",
        delta: "x".repeat(2_048),
      },
    );
    await flushMicrotasks();

    expect(readDraftCount(root)).toBe(1);
  });

  it("merges the last draft into an interrupted message on cold load and deletes it", async () => {
    const root = await createRoot();
    const store = storeFor(root);
    await store.create("coding-1", undefined, { scope: "coding" });
    await startAssistantMessage(store, "coding-1", "run-1", "user-1");
    await writeStreamEvent(
      store,
      "coding-1",
      "run-1",
      {
        type: "text-delta",
        partId: "text-1",
        delta: "partial answer",
      },
    );
    await store.close();
    expect(readDraftCount(root)).toBe(1);

    const reloaded = storeFor(root);
    const snapshot = await reloaded.load("coding-1");
    expect(snapshot.activeMessageId).toBeUndefined();
    expect(snapshot.messages[1]).toMatchObject({
      id: "run-1",
      text: "partial answer",
      status: "interrupted",
    });
    expect(readDraftCount(root)).toBe(0);
    expect(readRows(root).find((row) => row.message_id === "run-1")?.status).toBe("interrupted");
    expect(readSessionRevision(root).revision).toBe(1);
  });

  it("ignores and deletes a draft when a newer message row wins", async () => {
    const root = await createRoot();
    const store = storeFor(root);
    await store.create("coding-1", undefined, { scope: "coding" });
    await startAssistantMessage(store, "coding-1", "run-1", "user-1");
    await writeStreamEvent(
      store,
      "coding-1",
      "run-1",
      {
        type: "text-delta",
        partId: "text-1",
        delta: "stale draft",
      },
    );
    await store.close();
    expect(readDraftCount(root)).toBe(1);

    const db = new DatabaseSync(path.join(root, "sessions.sqlite"));
    const row = db
      .prepare(`
        SELECT message_json FROM session_messages
        WHERE conversation_id = ? AND message_id = ?
      `)
      .get("coding-1", "run-1") as { message_json: string };
    const message = JSON.parse(row.message_json) as { text: string; status: string };
    message.text = "newer";
    message.status = "complete";
    db.prepare(`
      UPDATE session_messages
      SET status = 'complete', message_json = ?
      WHERE conversation_id = ? AND message_id = ?
    `).run(JSON.stringify(message), "coding-1", "run-1");
    db.prepare("UPDATE sessions SET revision = revision + 1 WHERE conversation_id = ?").run(
      "coding-1",
    );
    db.close();

    const reloaded = storeFor(root);
    const snapshot = await reloaded.load("coding-1");
    expect(snapshot.messages[1]).toMatchObject({ text: "newer", status: "complete" });
    expect(readDraftCount(root)).toBe(0);
  });

  it("does not write a checkpoint against an older revision", async () => {
    const root = await createRoot();
    const store = storeFor(root);
    await store.create("coding-1", undefined, { scope: "coding" });
    await startAssistantMessage(store, "coding-1", "run-1", "user-1");

    const db = new DatabaseSync(path.join(root, "sessions.sqlite"));
    db.prepare("UPDATE sessions SET revision = revision + 1 WHERE conversation_id = ?").run(
      "coding-1",
    );
    db.close();

    await writeStreamEvent(
      store,
      "coding-1",
      "run-1",
      {
        type: "text-delta",
        partId: "text-1",
        delta: "x".repeat(2_048),
      },
    );
    await flushMicrotasks();

    expect(readDraftCount(root)).toBe(0);
  });

  it("pages messages from newest to oldest with an opaque stable cursor", async () => {
    const root = await createRoot();
    const store = storeFor(root);
    await store.create("coding-1", undefined, { scope: "coding" });
    for (let index = 0; index < 5; index += 1) {
      await store.appendUserMessage("coding-1", {
        id: `user-${index}`,
        role: "user",
        text: `message ${index}`,
        images: [],
        status: "complete",
      });
    }

    const first = await store.listMessages("coding-1", { scope: "coding", limit: 2 });
    expect(first.items.map((message) => message.id)).toEqual(["user-3", "user-4"]);
    if (first.nextCursor === undefined) throw new Error("缺少第一页游标");

    const second = await store.listMessages("coding-1", {
      scope: "coding",
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items.map((message) => message.id)).toEqual(["user-1", "user-2"]);
    if (second.nextCursor === undefined) throw new Error("缺少第二页游标");

    const third = await store.listMessages("coding-1", {
      scope: "coding",
      limit: 2,
      cursor: second.nextCursor,
    });
    expect(third.items.map((message) => message.id)).toEqual(["user-0"]);
    expect(third.nextCursor).toBeUndefined();
  });

  it("rejects malformed, cross-session and cross-scope message queries", async () => {
    const root = await createRoot();
    const store = storeFor(root);
    await store.create("coding-1", undefined, { scope: "coding" });
    await store.create("coding-2", undefined, { scope: "coding" });
    await store.appendUserMessage("coding-1", {
      id: "user-1",
      role: "user",
      text: "message",
      images: [],
      status: "complete",
    });
    await store.appendUserMessage("coding-2", {
      id: "user-2",
      role: "user",
      text: "message",
      images: [],
      status: "complete",
    });
    await store.appendUserMessage("coding-2", {
      id: "user-3",
      role: "user",
      text: "message",
      images: [],
      status: "complete",
    });
    const page = await store.listMessages("coding-2", { limit: 1 });
    if (page.nextCursor === undefined) throw new Error("缺少游标");

    await expect(store.listMessages("coding-1", { cursor: page.nextCursor })).rejects.toThrow(
      "消息游标无效",
    );
    await expect(store.listMessages("coding-1", { cursor: "not-a-cursor" })).rejects.toThrow(
      "消息游标无效",
    );
    await expect(store.listMessages("coding-1", { scope: "conversation" })).rejects.toThrow(
      "会话 scope 不匹配",
    );
  });

  it("fails a cold load with a corrupt draft instead of returning the placeholder", async () => {
    const root = await createRoot();
    const store = storeFor(root);
    await store.create("coding-1", undefined, { scope: "coding" });
    await startAssistantMessage(store, "coding-1", "run-1", "user-1");
    await store.close();

    const db = new DatabaseSync(path.join(root, "sessions.sqlite"));
    db.prepare(`
      INSERT INTO session_message_drafts
        (conversation_id, message_id, base_revision, draft_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run("coding-1", "run-1", 0, "{", new Date().toISOString());
    db.close();

    const reloaded = storeFor(root);
    await expect(reloaded.load("coding-1")).rejects.toBeInstanceOf(ConversationSessionCorruptError);
  });

  it("serves the in-memory streaming message and recovers a cold draft page", async () => {
    const root = await createRoot();
    const store = storeFor(root);
    await store.create("coding-1", undefined, { scope: "coding" });
    await startAssistantMessage(store, "coding-1", "run-1", "user-1");
    await writeStreamEvent(
      store,
      "coding-1",
      "run-1",
      {
        type: "text-delta",
        partId: "text-1",
        delta: "live",
      },
    );
    const live = await store.listMessages("coding-1", { limit: 1 });
    expect(live.items[0]).toMatchObject({ id: "run-1", text: "live", status: "streaming" });

    await store.close();
    const reloaded = storeFor(root);
    const recovered = await reloaded.listMessages("coding-1", { limit: 1 });
    expect(recovered.items[0]).toMatchObject({
      id: "run-1",
      text: "live",
      status: "interrupted",
    });
  });

  it("removes local drafts and streaming placeholders when another store wins the session", async () => {
    const root = await createRoot();
    const loser = storeFor(root);
    await loser.create("coding-1", undefined, { scope: "coding" });
    await loser.appendUserMessage("coding-1", {
      id: "user-0",
      role: "user",
      text: "initial",
      images: [],
      status: "complete",
    });
    await startAssistantMessage(loser, "coding-1", "run-loser", "user-loser");

    const winner = storeFor(root);
    await winner.load("coding-1");

    await writeStreamEvent(
      loser,
      "coding-1",
      "run-loser",
      {
        type: "text-delta",
        partId: "text-1",
        delta: "x".repeat(2_048),
      },
    );
    await flushMicrotasks();
    expect(readDraftCount(root)).toBe(1);

    await winner.appendUserMessage("coding-1", {
      id: "user-winner",
      role: "user",
      text: "winner",
      images: [],
      status: "complete",
    });

    await expect(
      loser.finishSessionAssistant("coding-1", "run-loser", "completed"),
    ).rejects.toBeInstanceOf(ConversationSessionConflictError);

    expect(readDraftCount(root)).toBe(0);
    const rows = readRows(root);
    expect(rows.map((row) => [row.message_id, row.status])).toEqual([
      ["user-0", "complete"],
      ["user-loser", "complete"],
      ["run-loser", "interrupted"],
      ["user-winner", "complete"],
    ]);
    const summary = await winner.getSession("coding-1");
    expect(summary?.messageCount).toBe(4);
    const cold = storeFor(root);
    expect((await cold.load("coding-1")).messages.map((message) => message.id)).toEqual([
      "user-0",
      "user-loser",
      "run-loser",
      "user-winner",
    ]);

    await expect(loser.delete("coding-1")).rejects.toBeInstanceOf(ConversationSessionConflictError);
  });
});
