import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionItemDraft, SessionItemStore } from "../../../src/core/transcript/itemStore";
import { MemorySessionItemStore } from "../../../src/core/transcript/memoryItemStore";
import { SESSION_SCHEMA_SQL } from "../../../src/core/transcript/persistence/sqlite/schema";
import { SqliteSessionItemStore } from "../../../src/core/transcript/persistence/sqlite/sqliteItemStore";

const AT = "2026-11-23T10:00:00.000Z";
const SESSION = "conversation-1";
const TURN = "turn-1";

interface Harness {
  store: SessionItemStore;
}

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const harnesses: ReadonlyArray<{ name: string; open: () => Promise<Harness> }> = [
  {
    name: "memory",
    async open() {
      const store = new MemorySessionItemStore();
      await store.create(SESSION);
      return { store };
    },
  },
  {
    name: "sqlite",
    async open() {
      const db = new DatabaseSync(":memory:");
      databases.push(db);
      db.exec("PRAGMA foreign_keys = ON");
      db.exec(SESSION_SCHEMA_SQL);
      db.prepare(`
        INSERT INTO sessions
          (conversation_id, scope, workspace_root, created_at, updated_at,
           title, message_count, state_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(SESSION, "conversation", null, AT, AT, "测试会话", 0, "{}");
      const store = new SqliteSessionItemStore(db);
      await store.create(SESSION);
      return { store };
    },
  },
];

describe.each(harnesses)("$name session item store", ({ open }) => {
  it("allocates contiguous seq and advances the cursor", async () => {
    const harness = await open();
    const appended = await harness.store.appendItems(SESSION, [
      userDraft("m-u1", TURN, "写一个函数"),
      textDraft("t-1", "m-a1", TURN, "先看现有实现。"),
      textDraft("t-2", "m-a1", TURN, "已加包装。"),
    ]);

    expect(appended.items.map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(appended.cursor).toEqual({ nextSeq: 4, messageCount: 2 });
    expect(await harness.store.readCursor(SESSION)).toEqual({ nextSeq: 4, messageCount: 2 });
  });

  it("ignores a duplicate item id without consuming seq", async () => {
    const harness = await open();
    const first = await harness.store.appendItems(SESSION, [
      textDraft("t-1", "m-a1", TURN, "一次"),
    ]);
    const second = await harness.store.appendItems(SESSION, [
      textDraft("t-1", "m-a1", TURN, "一次"),
    ]);

    expect(first.items).toHaveLength(1);
    expect(second.items).toEqual([]);
    expect(second.cursor.nextSeq).toBe(first.cursor.nextSeq);
    expect(await harness.store.readItems(SESSION)).toHaveLength(1);
  });

  it("counts each message once regardless of part count", async () => {
    const harness = await open();
    const appended = await harness.store.appendItems(SESSION, [
      userDraft("m-u1", TURN, "写一个函数"),
      textDraft("t-1", "m-a1", TURN, "一"),
      textDraft("t-2", "m-a1", TURN, "二"),
      reasoningDraft("r-1", "m-a1", TURN, "想了想"),
    ]);

    expect(appended.items).toHaveLength(4);
    expect(appended.cursor.messageCount).toBe(2);
  });

  it("writes turn-end and clears the open turn", async () => {
    const harness = await open();
    await harness.store.appendItems(SESSION, [userDraft("m-u1", TURN, "写一个函数")]);
    await harness.store.beginTurn(SESSION, TURN);
    expect((await harness.store.readCursor(SESSION))?.openTurnId).toBe(TURN);

    const finished = await harness.store.finishTurn(SESSION, TURN, turnEndDraft(TURN));

    expect(finished.items.map((item) => item.itemId)).toEqual([`${TURN}:end`]);
    expect(finished.cursor.openTurnId).toBeUndefined();
    expect((await harness.store.readCursor(SESSION))?.openTurnId).toBeUndefined();
  });

  it("keeps the open turn while appending its content", async () => {
    const harness = await open();
    await harness.store.beginTurn(SESSION, TURN);
    const appended = await harness.store.appendItems(SESSION, [
      textDraft("t-1", "m-a1", TURN, "正文"),
    ]);
    expect(appended.cursor.openTurnId).toBe(TURN);
  });

  it("does not write a second turn-end when the same turn closes twice", async () => {
    const harness = await open();
    await harness.store.beginTurn(SESSION, TURN);
    await harness.store.appendItems(SESSION, [textDraft("t-1", "m-a1", TURN, "正文")]);
    await harness.store.finishTurn(SESSION, TURN, turnEndDraft(TURN));

    const again = await harness.store.finishTurn(SESSION, TURN, turnEndDraft(TURN));

    expect(again.items).toEqual([]);
    const turnEnds = (await harness.store.readItems(SESSION)).filter(
      (item) => item.payload.kind === "turn-end",
    );
    expect(turnEnds).toHaveLength(1);
  });

  it("rejects a turn-end that closes a different turn", async () => {
    const harness = await open();
    await expect(harness.store.finishTurn(SESSION, TURN, turnEndDraft("turn-2"))).rejects.toThrow(
      /turnId/,
    );
  });

  it("pages items by seq", async () => {
    const harness = await open();
    await harness.store.appendItems(SESSION, [
      textDraft("t-1", "m-a1", TURN, "一"),
      textDraft("t-2", "m-a1", TURN, "二"),
      textDraft("t-3", "m-a1", TURN, "三"),
    ]);

    expect(
      (await harness.store.readItems(SESSION, { afterSeq: 1, limit: 1 })).map((i) => i.seq),
    ).toEqual([2]);
    expect((await harness.store.readItems(SESSION, { afterSeq: 2 })).map((i) => i.seq)).toEqual([
      3,
    ]);
  });

  it("resets the cursor on clear", async () => {
    const harness = await open();
    await harness.store.appendItems(SESSION, [userDraft("m-u1", TURN, "一")]);
    await harness.store.beginTurn(SESSION, TURN);

    await harness.store.clear(SESSION);

    expect(await harness.store.readItems(SESSION)).toEqual([]);
    expect(await harness.store.readCursor(SESSION)).toEqual({ nextSeq: 1, messageCount: 0 });
    const appended = await harness.store.appendItems(SESSION, [userDraft("m-u2", TURN, "二")]);
    expect(appended.items.map((item) => item.seq)).toEqual([1]);
  });

  it("fails loudly when the session does not exist", async () => {
    const harness = await open();
    await expect(
      harness.store.appendItems("missing", [textDraft("t-1", "m-a1", TURN, "正文")]),
    ).rejects.toThrow(/会话不存在/);
  });
});

function userDraft(messageId: string, turnId: string, text: string): SessionItemDraft {
  return {
    itemId: messageId,
    status: "complete",
    createdAt: AT,
    turnId,
    payload: { kind: "user", text, images: [] },
  };
}

function textDraft(
  itemId: string,
  messageId: string,
  turnId: string,
  text: string,
): SessionItemDraft {
  return {
    itemId,
    status: "complete",
    createdAt: AT,
    turnId,
    messageId,
    payload: { kind: "text", text },
  };
}

function reasoningDraft(
  itemId: string,
  messageId: string,
  turnId: string,
  text: string,
): SessionItemDraft {
  return {
    itemId,
    status: "complete",
    createdAt: AT,
    turnId,
    messageId,
    payload: { kind: "reasoning", text },
  };
}

function turnEndDraft(turnId: string): SessionItemDraft {
  return {
    itemId: `${turnId}:end`,
    status: "complete",
    createdAt: AT,
    turnId,
    payload: { kind: "turn-end", stepCount: 1, toolCalls: 0 },
  };
}
