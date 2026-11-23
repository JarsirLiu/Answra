/** 条目存储的内存实现：answer 域与测试用；语义与 SQLite 实现逐条一致。 */
import { type SessionItem, sessionItemSchema } from "@answra/shared/schema";
import {
  type AppendedSessionItems,
  type ReadSessionItemsOptions,
  type SessionItemCursor,
  type SessionItemDraft,
  type SessionItemStore,
  sessionItemMessageKey,
} from "./itemStore";

interface SessionItemsState {
  items: SessionItem[];
  itemIds: Set<string>;
  messageIds: Set<string>;
  cursor: SessionItemCursor;
}

export class MemorySessionItemStore implements SessionItemStore {
  private readonly sessions = new Map<string, SessionItemsState>();

  async create(conversationId: string): Promise<void> {
    if (this.sessions.has(conversationId)) return;
    this.sessions.set(conversationId, {
      items: [],
      itemIds: new Set(),
      messageIds: new Set(),
      cursor: { nextSeq: 1, messageCount: 0 },
    });
  }

  async appendItems(
    conversationId: string,
    items: readonly SessionItemDraft[],
  ): Promise<AppendedSessionItems> {
    return appendTo(this.require(conversationId), items);
  }

  async beginTurn(conversationId: string, turnId: string): Promise<void> {
    const state = this.require(conversationId);
    state.cursor = { ...state.cursor, openTurnId: turnId };
  }

  async finishTurn(
    conversationId: string,
    turnId: string,
    turnEnd: SessionItemDraft,
  ): Promise<AppendedSessionItems> {
    assertTurnEnd(turnEnd, turnId);
    const state = this.require(conversationId);
    const appended = appendTo(state, [turnEnd]);
    state.cursor = closeOpenTurn(state.cursor, turnId);
    return { items: appended.items, cursor: { ...state.cursor } };
  }

  async readItems(
    conversationId: string,
    options: ReadSessionItemsOptions = {},
  ): Promise<readonly SessionItem[]> {
    const state = this.sessions.get(conversationId);
    if (state === undefined) return [];
    const afterSeq = options.afterSeq ?? 0;
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    const items: SessionItem[] = [];
    for (const item of state.items) {
      if (item.seq <= afterSeq) continue;
      if (items.length >= limit) break;
      items.push({ ...item });
    }
    return items;
  }

  async readCursor(conversationId: string): Promise<SessionItemCursor | undefined> {
    const state = this.sessions.get(conversationId);
    return state === undefined ? undefined : { ...state.cursor };
  }

  async clear(conversationId: string): Promise<void> {
    const state = this.sessions.get(conversationId);
    if (state === undefined) return;
    state.items = [];
    state.itemIds = new Set();
    state.messageIds = new Set();
    state.cursor = { nextSeq: 1, messageCount: 0 };
  }

  private require(conversationId: string): SessionItemsState {
    const state = this.sessions.get(conversationId);
    if (state === undefined) throw new Error(`会话不存在，无法写条目：${conversationId}`);
    return state;
  }
}

function appendTo(
  state: SessionItemsState,
  drafts: readonly SessionItemDraft[],
): AppendedSessionItems {
  const appended: SessionItem[] = [];
  let nextSeq = state.cursor.nextSeq;
  let messageCount = state.cursor.messageCount;
  for (const draft of drafts) {
    if (state.itemIds.has(draft.itemId)) continue;
    const item = sessionItemSchema.parse({ ...draft, seq: nextSeq });
    state.items.push(item);
    state.itemIds.add(item.itemId);
    nextSeq += 1;
    const messageKey = sessionItemMessageKey(item);
    if (messageKey !== undefined && !state.messageIds.has(messageKey)) {
      state.messageIds.add(messageKey);
      messageCount += 1;
    }
    appended.push(item);
  }
  state.cursor = { ...state.cursor, nextSeq, messageCount };
  return { items: appended, cursor: { ...state.cursor } };
}

function closeOpenTurn(cursor: SessionItemCursor, turnId: string): SessionItemCursor {
  if (cursor.openTurnId !== turnId) return { ...cursor };
  return { nextSeq: cursor.nextSeq, messageCount: cursor.messageCount };
}

function assertTurnEnd(item: SessionItemDraft, turnId: string): void {
  if (item.payload.kind !== "turn-end") throw new Error("finishTurn 只接受 turn-end 条目");
  if (item.turnId !== turnId) throw new Error("turn-end 的 turnId 与收口 Turn 不一致");
}
