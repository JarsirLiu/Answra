/** `session_items` 的 SQLite 实现：seq 分配、游标回写与 turn-end 收口都在同一事务内。 */
import type { DatabaseSync } from "node:sqlite";
import { type SessionItem, sessionItemSchema } from "@answra/shared/schema";
import type {
  AppendedSessionItems,
  ReadSessionItemsOptions,
  SessionItemCursor,
  SessionItemDraft,
  SessionItemStore,
} from "../../itemStore";
import { sessionItemMessageKey } from "../../itemStore";
import {
  closeSessionOpenTurn,
  deleteSessionItemRows,
  insertSessionItemRow,
  listSessionItemRows,
  readSessionItemState,
  type SessionItemState,
  sessionItemMessageExists,
  setSessionOpenTurn,
  writeSessionItemState,
} from "./sessionItemRows";
import { withImmediateTransaction } from "./transaction";

export class SqliteSessionItemStore implements SessionItemStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async create(conversationId: string): Promise<void> {
    const state = readSessionItemState(this.db, conversationId);
    if (state === undefined) throw new Error(`会话不存在，无法初始化条目：${conversationId}`);
  }

  async appendItems(
    conversationId: string,
    items: readonly SessionItemDraft[],
  ): Promise<AppendedSessionItems> {
    return withImmediateTransaction(this.db, () => this.appendInside(conversationId, items));
  }

  async beginTurn(conversationId: string, turnId: string): Promise<void> {
    withImmediateTransaction(this.db, () => {
      requireState(this.db, conversationId);
      setSessionOpenTurn(this.db, conversationId, turnId);
    });
  }

  async finishTurn(
    conversationId: string,
    turnId: string,
    turnEnd: SessionItemDraft,
  ): Promise<AppendedSessionItems> {
    assertTurnEnd(turnEnd, turnId);
    return withImmediateTransaction(this.db, () => {
      const appended = this.appendInside(conversationId, [turnEnd]);
      closeSessionOpenTurn(this.db, conversationId, turnId);
      return { items: appended.items, cursor: requireState(this.db, conversationId) };
    });
  }

  async readItems(
    conversationId: string,
    options: ReadSessionItemsOptions = {},
  ): Promise<readonly SessionItem[]> {
    return listSessionItemRows(this.db, conversationId, options);
  }

  async readCursor(conversationId: string): Promise<SessionItemCursor | undefined> {
    return readSessionItemState(this.db, conversationId);
  }

  async clear(conversationId: string): Promise<void> {
    withImmediateTransaction(this.db, () => {
      deleteSessionItemRows(this.db, conversationId);
      writeSessionItemState(this.db, conversationId, { nextSeq: 1, messageCount: 0 });
    });
  }

  /** 调用方必须已开启事务；`seq` 只在插入成功时前进。 */
  private appendInside(
    conversationId: string,
    drafts: readonly SessionItemDraft[],
  ): AppendedSessionItems {
    const state = requireState(this.db, conversationId);
    const appended: SessionItem[] = [];
    let nextSeq = state.nextSeq;
    let messageCount = state.messageCount;
    let lastCreatedAt: string | undefined;
    for (const draft of drafts) {
      const item = sessionItemSchema.parse({ ...draft, seq: nextSeq });
      const messageKey = sessionItemMessageKey(item);
      const firstOfMessage =
        messageKey !== undefined && !sessionItemMessageExists(this.db, conversationId, messageKey);
      if (!insertSessionItemRow(this.db, conversationId, item)) continue;
      appended.push(item);
      nextSeq += 1;
      lastCreatedAt = item.createdAt;
      if (firstOfMessage) messageCount += 1;
    }
    const cursor: SessionItemState = {
      nextSeq,
      messageCount,
      ...(state.openTurnId === undefined ? {} : { openTurnId: state.openTurnId }),
    };
    if (appended.length > 0 && lastCreatedAt !== undefined) {
      writeSessionItemState(this.db, conversationId, cursor, lastCreatedAt);
    }
    return { items: appended, cursor };
  }
}

function requireState(db: DatabaseSync, conversationId: string): SessionItemState {
  const state = readSessionItemState(db, conversationId);
  if (state === undefined) throw new Error(`会话不存在，无法写条目：${conversationId}`);
  return state;
}

function assertTurnEnd(item: SessionItemDraft, turnId: string): void {
  if (item.payload.kind !== "turn-end") throw new Error("finishTurn 只接受 turn-end 条目");
  if (item.turnId !== turnId) throw new Error("turn-end 的 turnId 与收口 Turn 不一致");
}
