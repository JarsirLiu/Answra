/** 只追加条目存储端口；只定义写入与读取，不判断 Turn 语义、不折叠消息。 */
import type { SessionItem } from "@answra/shared/schema";

/** 尚未分配 `seq` 的条目；`seq` 由存储层在同一事务内分配。 */
export type SessionItemDraft = Omit<SessionItem, "seq">;

/** 会话行上由条目写入维护的游标；`lastSeq` 恒为 `nextSeq - 1`。 */
export interface SessionItemCursor {
  /** 下一条目要分配的 `seq`；空会话为 1。 */
  nextSeq: number;
  messageCount: number;
  /** 正在执行的 Turn；只有它能解释「缺少 turn-end」。 */
  openTurnId?: string;
}

export interface AppendedSessionItems {
  /** 本次真正插入的条目；命中去重约束的草稿不在其中。 */
  items: readonly SessionItem[];
  cursor: SessionItemCursor;
}

export interface ReadSessionItemsOptions {
  /** 只读该 seq 之后的条目；缺省从 1 开始。 */
  afterSeq?: number;
  /** 正数限制条数；缺省读取全部。 */
  limit?: number;
}

/**
 * `message_count` 的消息身份：part 条目用 `messageId`，`user` 条目用 `itemId`。
 *
 * user 条目没有 `messageId` 列（它的 itemId 就是消息 id），所以要单独归一；
 * 两个存储实现必须用同一规则，否则同一份数据在内存与磁盘上数出不同结果。
 */
export function sessionItemMessageKey(
  item: Pick<SessionItem, "itemId" | "messageId" | "payload">,
): string | undefined {
  if (item.payload.kind === "user") return item.itemId;
  return item.messageId;
}

/**
 * `session_items` 的读写面，供 Session 运行时与桌面 / CLI 历史补齐共用。
 *
 * 不变量（实现必须保证）：
 * - `seq` 只在插入成功时前进，同一 `item_id` 重复写入是 no-op；
 * - `turn-end` 与 `openTurnId` 的清空在同一事务内完成。
 */
export interface SessionItemStore {
  /** 初始化会话的条目游标；已存在时 no-op。会话本身由 `ConversationStore.create` 建立。 */
  create(conversationId: string): Promise<void>;
  appendItems(
    conversationId: string,
    items: readonly SessionItemDraft[],
  ): Promise<AppendedSessionItems>;
  /** Turn 真正开始时置位；提交消息时不置。 */
  beginTurn(conversationId: string, turnId: string): Promise<void>;
  /** 追加 `turn-end` 并清空指向该 Turn 的 `openTurnId`。 */
  finishTurn(
    conversationId: string,
    turnId: string,
    turnEnd: SessionItemDraft,
  ): Promise<AppendedSessionItems>;
  readItems(
    conversationId: string,
    options?: ReadSessionItemsOptions,
  ): Promise<readonly SessionItem[]>;
  readCursor(conversationId: string): Promise<SessionItemCursor | undefined>;
  /** 清空条目并把游标重置回 1；会话行本身保留。 */
  clear(conversationId: string): Promise<void>;
}
