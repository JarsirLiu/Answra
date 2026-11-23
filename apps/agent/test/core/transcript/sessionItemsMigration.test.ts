import { DatabaseSync } from "node:sqlite";
import type { ConversationMessage, ConversationMessagePart } from "@answra/shared";
import { foldSessionItems } from "@answra/shared/schema";
import { afterEach, describe, expect, it } from "vitest";
import { restoreConversationSnapshot } from "../../../src/core/transcript/persistence/restore";
import { migration } from "../../../src/core/transcript/persistence/sqlite/migration/migrations/20261123120000_session_items";
import { migration as dropLegacyMigration } from "../../../src/core/transcript/persistence/sqlite/migration/migrations/20261123130000_drop_legacy_session_tables";
import { SESSION_SCHEMA_SQL } from "../../../src/core/transcript/persistence/sqlite/schema";
import {
  insertSessionItemRow,
  listSessionItemRows,
  readSessionItemState,
} from "../../../src/core/transcript/persistence/sqlite/sessionItemRows";
import { PREVIOUS_SESSION_SCHEMA_SQL } from "./legacySessionSchemaFixture";

const AT = "2026-11-23T10:00:00.000Z";
const SESSION = "conversation-1";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("session items migration", () => {
  it("upgrades the previous schema to the current baseline", () => {
    const db = openDatabase();
    migration.up(db);
    dropLegacyMigration.up(db);

    const baseline = new DatabaseSync(":memory:");
    databases.push(baseline);
    baseline.exec(SESSION_SCHEMA_SQL);

    expect(readColumns(db, "sessions")).toEqual(readColumns(baseline, "sessions"));
    expect(readTableSql(db, "session_items")).toBe(readTableSql(baseline, "session_items"));
    expect(readColumns(db, "sessions").map((column) => column.name)).not.toContain("revision");
    expect(readTableSql(db, "session_messages")).toBeUndefined();
    expect(readTableSql(db, "meta")).toBeUndefined();
  });

  it("folds a completed turn identically to the restored transcript", () => {
    const db = openDatabase();
    insertSession(db);
    insertMessage(db, 1, userMessage("m-u1", "先看现有实现，然后加包装。"));
    insertMessage(
      db,
      2,
      assistantMessage("m-a1", [
        textPart("t-1", "先看现有实现。"),
        toolPart("c-1", "read", { path: "src/x.ts" }, { output: { preview: "ok" } }),
        textPart("t-2", "已加包装。"),
      ]),
    );

    migration.up(db);

    expect(expectRestoredEquivalent(db)).toEqual(["m-u1:user", "m-a1:assistant:complete"]);
    expect(foldedMessages(db).map((message) => message.text)).toEqual([
      "先看现有实现，然后加包装。",
      "先看现有实现。已加包装。",
    ]);
    expect(readSessionItemState(db, SESSION)).toEqual({
      nextSeq: 7,
      messageCount: 2,
    });
    expect(turnEnds(db)).toMatchObject([
      {
        itemId: "m-u1:end",
        status: "complete",
        turnId: "m-u1",
        toolCalls: 1,
      },
    ]);
  });

  it("merges the current draft and marks the crashed turn as interrupted", () => {
    const db = openDatabase();
    insertSession(db, { revision: 3 });
    insertMessage(db, 1, userMessage("m-u1", "写一个函数"));
    insertMessage(db, 2, assistantMessage("m-a1", [textPart("t-1", "先写一半")], "streaming"));
    insertDraft(db, "m-a1", 2, assistantMessage("m-a1", [textPart("t-1", "过期草稿")]));
    insertDraft(
      db,
      "m-a1",
      3,
      assistantMessage(
        "m-a1",
        [textPart("t-1", "先写一半，再补完。"), textPart("t-2", "另外")],
        "streaming",
      ),
    );

    migration.up(db);

    expect(
      expectRestoredEquivalent(db, [userMessage("m-u1", "写一个函数"), draftMergedMessage()]),
    ).toEqual(["m-u1:user", "m-a1:assistant:interrupted"]);
    expect(foldedMessages(db)[1]?.text).toBe("先写一半，再补完。另外");
    expect(turnEnds(db)[0]).toMatchObject({
      status: "interrupted",
      payload: { interruption: { reason: "process-exit", at: AT } },
    });
  });

  it("keeps a failed turn and its tool error", () => {
    const db = openDatabase();
    insertSession(db);
    insertMessage(db, 1, userMessage("m-u1", "跑一下测试"));
    insertMessage(
      db,
      2,
      assistantMessage(
        "m-a1",
        [textPart("t-1", "开始"), failedToolPart("c-1", "shell", "exit 1")],
        "failed",
      ),
    );

    migration.up(db);

    expect(expectRestoredEquivalent(db)).toEqual(["m-u1:user", "m-a1:assistant:failed"]);
    expect(turnEnds(db)[0]).toMatchObject({ status: "failed" });
  });

  it("preserves handoff authors and audiences", () => {
    const db = openDatabase();
    insertSession(db);
    insertMessage(db, 1, userMessage("m-u1", "请整理"));
    insertMessage(db, 2, assistantMessage("m-a1", [textPart("t-1", "交给整理 Bot。")]));
    insertMessage(db, 3, handoffMessage("m-h1", "general", "intake", "整理这份资料"));
    insertMessage(
      db,
      4,
      assistantMessage("m-a2", [textPart("t-2", "整理完成。")], "complete", {
        authorAgentId: "intake",
      }),
    );

    migration.up(db);

    const folded = foldedMessages(db);
    expect(folded.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "assistant",
      "assistant",
    ]);
    expect(folded[2]).toMatchObject({
      id: "m-h1",
      authorAgentId: "general",
      audience: { kind: "bot", agentId: "intake" },
      text: "整理这份资料",
      status: "complete",
    });
    expect(folded[3]).toMatchObject({
      id: "m-a2",
      authorAgentId: "intake",
      audience: { kind: "user" },
      status: "complete",
    });
    expect(turnEnds(db)).toHaveLength(1);
  });

  it("keeps an opening turn without a user message", () => {
    const db = openDatabase();
    insertSession(db);
    insertMessage(db, 1, assistantMessage("m-open", [textPart("t-1", "你好，我们开始吧。")]));

    migration.up(db);

    expect(foldedMessages(db).map((message) => message.id)).toEqual(["m-open"]);
    expect(turnEnds(db)[0]).toMatchObject({
      itemId: "opening:m-open:end",
      turnId: "opening:m-open",
      status: "complete",
    });
    expect(readSessionItemState(db, SESSION)?.messageCount).toBe(1);
  });

  it("drops the blank assistant placeholder without counting it", () => {
    const db = openDatabase();
    insertSession(db);
    insertMessage(db, 1, userMessage("m-u1", "在吗"));
    insertMessage(db, 2, assistantMessage("m-a1", [], "streaming"));

    migration.up(db);

    expect(foldedMessages(db).map((message) => message.id)).toEqual(["m-u1"]);
    expect(readSessionItemState(db, SESSION)).toEqual({ nextSeq: 3, messageCount: 1 });
    expect(turnEnds(db)[0]).toMatchObject({ status: "interrupted" });
  });

  it("inserts an existing item idempotently and pages by seq", () => {
    const db = openDatabase();
    insertSession(db);
    insertMessage(db, 1, userMessage("m-u1", "一"));
    insertMessage(db, 2, assistantMessage("m-a1", [textPart("t-1", "二")]));
    migration.up(db);

    const items = listSessionItemRows(db, SESSION);
    const first = items[0];
    if (first === undefined) throw new Error("迁移没有产出条目");
    expect(insertSessionItemRow(db, SESSION, first)).toBe(false);
    expect(listSessionItemRows(db, SESSION)).toHaveLength(items.length);

    expect(listSessionItemRows(db, SESSION, { afterSeq: 1, limit: 1 })).toHaveLength(1);
    expect(listSessionItemRows(db, SESSION, { afterSeq: 1, limit: 1 })[0]?.seq).toBe(2);
    expect(readSessionItemState(db, SESSION)?.nextSeq).toBe(items.length + 1);
  });

  it("scopes repeated provider part ids so every text block is kept", () => {
    const db = openDatabase();
    insertSession(db);
    insertMessage(db, 1, userMessage("m-u1", "第一轮"));
    insertMessage(db, 2, assistantMessage("m-a1", [textPart("txt-0", "第一段")]));
    insertMessage(db, 3, userMessage("m-u2", "第二轮"));
    insertMessage(
      db,
      4,
      assistantMessage("m-a2", [
        textPart("txt-0", "第二段"),
        toolPart("c-1", "read", { path: "a" }, { output: "ok" }),
        textPart("txt-0", "第三段"),
      ]),
    );

    migration.up(db);

    const items = listSessionItemRows(db, SESSION);
    expect(new Set(items.map((item) => item.itemId)).size).toBe(items.length);
    expect(foldedMessages(db).map((message) => message.text)).toEqual([
      "第一轮",
      "第一段",
      "第二轮",
      "第二段第三段",
    ]);
  });
});

function openDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(PREVIOUS_SESSION_SCHEMA_SQL);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function insertSession(db: DatabaseSync, { revision = 0 }: { revision?: number } = {}): void {
  db.prepare(`
    INSERT INTO sessions
      (conversation_id, scope, workspace_root, created_at, updated_at, revision,
       title, message_count, state_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(SESSION, "conversation", null, AT, AT, revision, "测试会话", 0, "{}");
}

function insertMessage(db: DatabaseSync, seq: number, message: ConversationMessage): void {
  db.prepare(`
    INSERT INTO session_messages
      (conversation_id, message_id, turn_id, seq, role, status, message_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(SESSION, message.id, null, seq, message.role, message.status, JSON.stringify(message));
}

function insertDraft(
  db: DatabaseSync,
  messageId: string,
  baseRevision: number,
  message: ConversationMessage,
): void {
  db.prepare(`
    INSERT INTO session_message_drafts
      (conversation_id, message_id, base_revision, draft_json, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id, message_id) DO UPDATE SET
      base_revision = excluded.base_revision,
      draft_json = excluded.draft_json,
      updated_at = excluded.updated_at
  `).run(SESSION, messageId, baseRevision, JSON.stringify(message), AT);
}

function userMessage(id: string, text: string): ConversationMessage {
  return {
    id,
    role: "user",
    audience: { kind: "user" },
    text,
    images: [],
    status: "complete",
    parts: [],
  };
}

function assistantMessage(
  id: string,
  parts: ConversationMessagePart[],
  status: ConversationMessage["status"] = "complete",
  options: { authorAgentId?: string } = {},
): ConversationMessage {
  return {
    id,
    role: "assistant",
    authorAgentId: options.authorAgentId ?? "general",
    audience: { kind: "user" },
    text: join(parts, "text"),
    images: [],
    status,
    parts,
    ...(join(parts, "reasoning") === "" ? {} : { reasoning: join(parts, "reasoning") }),
  };
}

function handoffMessage(
  id: string,
  fromAgentId: string,
  toAgentId: string,
  text: string,
): ConversationMessage {
  return {
    id,
    role: "assistant",
    authorAgentId: fromAgentId,
    audience: { kind: "bot", agentId: toAgentId },
    text,
    images: [],
    status: "complete",
    parts: [],
  };
}

function textPart(id: string, text: string): ConversationMessagePart {
  return { id, kind: "text", text, state: "completed" };
}

function toolPart(
  id: string,
  toolName: string,
  input: unknown,
  result: { output?: unknown; errorText?: string; state?: "completed" | "failed" | "denied" } = {
    state: "completed",
  },
): ConversationMessagePart {
  return {
    id,
    kind: "tool",
    toolCallId: id,
    toolName,
    input,
    state: result.state ?? "completed",
    ...(result.output === undefined ? {} : { output: result.output }),
    ...(result.errorText === undefined ? {} : { errorText: result.errorText }),
  };
}

function failedToolPart(id: string, toolName: string, errorText: string): ConversationMessagePart {
  return toolPart(id, toolName, undefined, { state: "failed", errorText });
}

/** 迁移应把同一 part 的 call 与 result 折回一条 tool part。 */
function draftMergedMessage(): ConversationMessage {
  return assistantMessage(
    "m-a1",
    [textPart("t-1", "先写一半，再补完。"), textPart("t-2", "另外")],
    "streaming",
  );
}

function join(parts: readonly ConversationMessagePart[], kind: "text" | "reasoning"): string {
  let text = "";
  for (const part of parts) if (part.kind === kind) text += part.text;
  return text;
}

function foldedMessages(db: DatabaseSync, openTurnId?: string) {
  return foldSessionItems(
    listSessionItemRows(db, SESSION),
    openTurnId === undefined ? {} : { openTurnId },
  );
}

/**
 * 用迁移前同一份消息（含草稿合并）走 `restoreConversationSnapshot`，
 * 再与折叠结果逐字段比较；两处唯一的形状差异是折叠总会物化 `audience` 与 text part。
 */
function expectRestoredEquivalent(db: DatabaseSync, overrides?: ConversationMessage[]): string[] {
  const restored = restoreConversationSnapshot({
    conversationId: SESSION,
    messages: overrides ?? readStoredMessages(db),
  }).messages;
  const folded = foldedMessages(db);
  // part id 是存储侧派生键（按消息作用域重编号），不参与转录语义比较。
  expect(folded.map(normalizePartIds)).toEqual(normalizeRestored(restored).map(normalizePartIds));
  return folded.map((message) =>
    message.role === "user" ? `${message.id}:user` : `${message.id}:assistant:${message.status}`,
  );
}

function normalizePartIds(message: ConversationMessage): ConversationMessage {
  if (message.parts === undefined) return message;
  return {
    ...message,
    parts: message.parts.map((part, index) => ({ ...part, id: `${part.kind}-${index}` })),
  };
}

function readStoredMessages(db: DatabaseSync): ConversationMessage[] {
  return (
    db
      .prepare(`
        SELECT message_json
        FROM session_messages
        WHERE conversation_id = ?
        ORDER BY seq ASC
      `)
      .all(SESSION) as unknown as { message_json: string }[]
  ).map((row) => JSON.parse(row.message_json) as ConversationMessage);
}

function normalizeRestored(messages: readonly ConversationMessage[]): ConversationMessage[] {
  return messages
    .filter((message) => message.role === "user" || hasVisibleContent(message))
    .map((message) => {
      const status = message.status === "streaming" ? "interrupted" : message.status;
      const base: ConversationMessage = {
        ...message,
        audience: message.audience ?? { kind: "user" },
        images: [...message.images],
        status,
      };
      if (message.role === "user") return { ...base, parts: [] };
      const parts = message.parts ?? [];
      if (parts.length > 0) return { ...base, parts: parts.map((part) => ({ ...part })) };
      if (message.text.length === 0) return { ...base, parts: [] };
      return {
        ...base,
        parts: [
          {
            id: `${message.id}:text`,
            kind: "text",
            text: message.text,
            state: partStateOfStatus(status),
          } satisfies ConversationMessagePart,
        ],
      };
    });
}

function hasVisibleContent(message: ConversationMessage): boolean {
  if (message.role === "user") return true;
  return message.text.length > 0 || (message.parts?.length ?? 0) > 0;
}

function partStateOfStatus(
  status: ConversationMessage["status"],
): "completed" | "failed" | "interrupted" {
  if (status === "complete") return "completed";
  return status === "failed" ? "failed" : "interrupted";
}

function turnEnds(db: DatabaseSync) {
  return listSessionItemRows(db, SESSION)
    .filter((item) => item.payload.kind === "turn-end")
    .map((item) => ({
      itemId: item.itemId,
      status: item.status,
      turnId: item.turnId,
      toolCalls: item.payload.kind === "turn-end" ? item.payload.toolCalls : -1,
      ...(item.payload.kind === "turn-end" ? { payload: item.payload } : {}),
    }));
}

function readColumns(db: DatabaseSync, table: string) {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>
  )
    .map((row) => ({
      name: row.name,
      type: row.type,
      notnull: row.notnull,
      defaultValue: row.dflt_value,
      primaryKey: row.pk,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function readTableSql(db: DatabaseSync, table: string): string | undefined {
  const row = db
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(table) as { sql: string } | undefined;
  return row?.sql;
}
