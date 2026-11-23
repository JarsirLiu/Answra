/**
 * 仅供 `20261123120000_session_items` 回填使用；该迁移发布后本文件即冻结，不得复用或修改。
 *
 * 把旧 `session_messages`（含当前 revision 的草稿）展开成只追加的 `session_items`：
 * 以用户消息为 Turn 边界分组，Turn 末尾补 `turn-end`，并回写 `next_seq` / `message_count`。
 */
import type { DatabaseSync } from "node:sqlite";
import {
  type LegacyMessage,
  type LegacyPart,
  mergeLegacyDraft,
  parseLegacyMessage,
} from "./legacyMessage";

type ItemKind = "user" | "text" | "reasoning" | "tool-call" | "tool-result" | "turn-end";
type ItemStatus = "complete" | "interrupted" | "failed";

interface SessionRow {
  conversation_id: string;
  revision: number;
  updated_at: string;
}

interface MessageRow {
  message_id: string;
  seq: number;
  turn_id: string | null;
  message_json: string;
}

interface DraftRow {
  message_id: string;
  base_revision: number;
  draft_json: string;
}

interface MessageEntry {
  row: MessageRow;
  message: LegacyMessage;
}

interface MessageGroup {
  turnId: string;
  messages: MessageEntry[];
}

interface ItemDraft {
  itemId: string;
  kind: ItemKind;
  status: ItemStatus;
  turnId?: string;
  messageId?: string;
  authorAgentId?: string;
  audienceAgentId?: string;
  payload: Record<string, unknown>;
}

const INSERT_ITEM_SQL = `
  INSERT INTO session_items
    (conversation_id, seq, item_id, kind, status, turn_id, message_id,
     author_agent_id, audience_agent_id, created_at, payload_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export function backfillSessionItems(db: DatabaseSync): void {
  const sessions = db
    .prepare("SELECT conversation_id, revision, updated_at FROM sessions")
    .all() as unknown as SessionRow[];
  for (const session of sessions) {
    backfillSession(db, session);
  }
}

function backfillSession(db: DatabaseSync, session: SessionRow): void {
  const rows = db
    .prepare(`
      SELECT message_id, seq, turn_id, message_json
      FROM session_messages
      WHERE conversation_id = ?
      ORDER BY seq ASC
    `)
    .all(session.conversation_id) as unknown as MessageRow[];
  if (rows.length === 0) return;

  const createdAt = toIsoTimestamp(session.updated_at);
  const drafts = readDrafts(db, session);
  const groups = groupMessages(
    rows.map((row) => {
      const message = parseLegacyMessage(row.message_json, row.message_id);
      const draft = drafts.get(row.message_id);
      return { row, message: draft === undefined ? message : mergeLegacyDraft(message, draft) };
    }),
  );

  const insert = db.prepare(INSERT_ITEM_SQL);
  let seq = 0;
  let messageCount = 0;
  for (const group of groups) {
    let toolCalls = 0;
    for (const { message } of group.messages) {
      const items = expandMessage(group.turnId, message);
      if (items.length === 0) continue;
      messageCount += 1;
      for (const item of items) {
        seq += 1;
        if (item.kind === "tool-call") toolCalls += 1;
        insertItem(insert, session.conversation_id, seq, createdAt, item);
      }
    }
    seq += 1;
    insertItem(
      insert,
      session.conversation_id,
      seq,
      createdAt,
      turnEndItem(group, toolCalls, createdAt),
    );
  }

  db.prepare("UPDATE sessions SET next_seq = ?, message_count = ? WHERE conversation_id = ?").run(
    seq + 1,
    messageCount,
    session.conversation_id,
  );
}

function readDrafts(db: DatabaseSync, session: SessionRow): Map<string, LegacyMessage> {
  const rows = db
    .prepare(`
      SELECT message_id, base_revision, draft_json
      FROM session_message_drafts
      WHERE conversation_id = ?
    `)
    .all(session.conversation_id) as unknown as DraftRow[];
  const drafts = new Map<string, LegacyMessage>();
  for (const row of rows) {
    // 与 `mergeStoredSession` 同义：只有基于当前 revision 的草稿才是那半句的唯一副本。
    if (row.base_revision !== session.revision) continue;
    drafts.set(row.message_id, parseLegacyMessage(row.draft_json, row.message_id));
  }
  return drafts;
}

/**
 * 以用户消息为 Turn 边界分组：一条用户消息开启一个 Turn，其后的 assistant 消息同属该 Turn；
 * 首条用户消息之前的 assistant 消息属于开场 Turn。`session_messages.turn_id` 能对上时优先沿用。
 */
function groupMessages(messages: readonly MessageEntry[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let current: MessageGroup | undefined;
  for (const entry of messages) {
    if (entry.message.role === "user") {
      current = { turnId: resolveTurnId(entry, entry.message.id), messages: [] };
      groups.push(current);
    } else if (current === undefined) {
      current = { turnId: resolveTurnId(entry, `opening:${entry.message.id}`), messages: [] };
      groups.push(current);
    }
    current.messages.push(entry);
  }
  return groups;
}

function resolveTurnId(entry: MessageEntry, fallback: string): string {
  const stored = entry.row.turn_id;
  if (stored !== null && stored.length > 0) return stored;
  return fallback;
}

function expandMessage(turnId: string, message: LegacyMessage): ItemDraft[] {
  // user 条目没有作者与接收方；旧记录即使误带也不能写进只追加表。
  const base = {
    turnId,
    ...(message.role === "assistant" && message.authorAgentId !== undefined
      ? { authorAgentId: message.authorAgentId }
      : {}),
    ...(message.role === "assistant" && message.audience?.kind === "bot" && message.audience.agentId
      ? { audienceAgentId: message.audience.agentId }
      : {}),
  };
  if (message.role === "user") {
    return [
      {
        ...base,
        itemId: message.id,
        kind: "user",
        status: "complete",
        payload: { kind: "user", text: message.text, images: message.images },
      },
    ];
  }
  const messageBase = { ...base, messageId: message.id };
  const parts = message.parts ?? [];
  if (parts.length === 0) {
    const items: ItemDraft[] = [];
    if (message.text.length > 0) {
      items.push({
        ...messageBase,
        itemId: `${message.id}:text`,
        kind: "text",
        status: itemStatusOfMessage(message.status),
        payload: { kind: "text", text: message.text },
      });
    }
    if ((message.reasoning ?? "").length > 0) {
      items.push({
        ...messageBase,
        itemId: `${message.id}:reasoning`,
        kind: "reasoning",
        status: itemStatusOfMessage(message.status),
        payload: { kind: "reasoning", text: message.reasoning },
      });
    }
    return items;
  }
  // 旧 part id 只在单条消息内唯一（provider 固定发 `txt-0` / `reasoning-0`），
  // 而条目 id 要求会话内唯一，所以按消息作用域重新编号。
  const partIds = new Map<string, number>();
  return parts.flatMap((part) => expandPart(messageBase, part, partIds));
}

function expandPart(
  base: {
    turnId: string;
    messageId: string;
    authorAgentId?: string;
    audienceAgentId?: string;
  },
  part: LegacyPart,
  partIds: Map<string, number>,
): ItemDraft[] {
  switch (part.kind) {
    case "text":
      return [
        {
          ...base,
          itemId: scopedPartId(base.messageId, requireItemId(part.id, "text part"), partIds),
          kind: "text",
          status: itemStatusOfPart(part.state),
          payload: { kind: "text", text: requirePartText(part.text) },
        },
      ];
    case "reasoning":
      return [
        {
          ...base,
          itemId: scopedPartId(base.messageId, requireItemId(part.id, "reasoning part"), partIds),
          kind: "reasoning",
          status: itemStatusOfPart(part.state),
          payload: { kind: "reasoning", text: requirePartText(part.text) },
        },
      ];
    case "tool":
      return expandToolPart(base, part);
    default:
      throw new Error(`无法迁移未知的 part 类型：${String(part.kind)}`);
  }
}

function expandToolPart(
  base: {
    turnId: string;
    messageId: string;
    authorAgentId?: string;
    audienceAgentId?: string;
  },
  part: LegacyPart,
): ItemDraft[] {
  const toolCallId = requireItemId(part.toolCallId, "tool part");
  const items: ItemDraft[] = [
    {
      ...base,
      itemId: requireItemId(part.id, "tool part"),
      kind: "tool-call",
      status: "complete",
      payload: {
        kind: "tool-call",
        toolCallId,
        toolName: requirePartText(part.toolName),
        ...(part.title === undefined ? {} : { title: part.title }),
        ...(part.input === undefined ? {} : { input: part.input }),
        ...(part.inputText === undefined ? {} : { inputText: part.inputText }),
      },
    },
  ];
  const outcome = toolOutcomeOf(part.state);
  if (outcome === undefined) return items;
  items.push({
    ...base,
    itemId: `${toolCallId}:result`,
    kind: "tool-result",
    status: "complete",
    payload: {
      kind: "tool-result",
      toolCallId,
      outcome,
      ...(outcome === "output" ? { output: part.output } : {}),
      ...(outcome === "error" && part.errorText !== undefined ? { errorText: part.errorText } : {}),
    },
  });
  return items;
}

/** Turn 收口状态来自该 Turn 最后一条 assistant 消息；没有 assistant 的 Turn 视为中断。 */
function turnEndItem(group: MessageGroup, toolCalls: number, createdAt: string): ItemDraft {
  const last = [...group.messages].reverse().find((entry) => entry.message.role === "assistant");
  const status: ItemStatus =
    last === undefined
      ? "interrupted"
      : last.message.status === "complete"
        ? "complete"
        : last.message.status === "failed"
          ? "failed"
          : "interrupted";
  return {
    itemId: `${group.turnId}:end`,
    kind: "turn-end",
    status,
    turnId: group.turnId,
    payload: {
      kind: "turn-end",
      stepCount: 0,
      toolCalls,
      ...(status === "interrupted"
        ? {
            interruption: {
              reason: last?.message.status === "streaming" ? "process-exit" : "migrated",
              at: createdAt,
            },
          }
        : {}),
    },
  };
}

function insertItem(
  insert: ReturnType<DatabaseSync["prepare"]>,
  conversationId: string,
  seq: number,
  createdAt: string,
  item: ItemDraft,
): void {
  insert.run(
    conversationId,
    seq,
    item.itemId,
    item.kind,
    item.status,
    item.turnId ?? null,
    item.messageId ?? null,
    item.authorAgentId ?? null,
    item.audienceAgentId ?? null,
    createdAt,
    JSON.stringify(item.payload),
  );
}

function itemStatusOfPart(state: string | undefined): ItemStatus {
  if (state === "completed") return "complete";
  if (state === "failed") return "failed";
  return "interrupted";
}

function itemStatusOfMessage(status: LegacyMessage["status"]): ItemStatus {
  if (status === "complete") return "complete";
  if (status === "failed") return "failed";
  return "interrupted";
}

function toolOutcomeOf(state: string | undefined): "output" | "error" | "denied" | undefined {
  if (state === "completed") return "output";
  if (state === "failed") return "error";
  if (state === "denied") return "denied";
  return undefined;
}

function requirePartText(value: unknown): string {
  if (typeof value !== "string") throw new Error("迁移字段必须是字符串");
  return value;
}

function requireItemId(value: unknown, label: string): string {
  const id = requirePartText(value);
  if (id.length === 0) throw new Error(`迁移字段缺少 ${label} id`);
  return id;
}

/** 同一会话内条目 id 必须唯一；旧 part id 只保证消息内唯一，按出现次数补序号。 */
function scopedPartId(messageId: string, partId: string, used: Map<string, number>): string {
  const next = (used.get(partId) ?? 0) + 1;
  used.set(partId, next);
  return `${messageId}:${partId}:${next}`;
}

function toIsoTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`会话时间戳无效：${value}`);
  return parsed.toISOString();
}
