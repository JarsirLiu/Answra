/**
 * SQLite transcript 适配器：会话行只存元数据与上下文状态，消息由 `session_items` 折出。
 *
 * 写入方仍是内存工作集（模型流事件、活动消息），条目由 `SessionItemStore` 维护；
 * 这里只负责：把会话行落库、启动时折条目、恢复后重建消息视图、历史分页与删除。
 */
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
  ConversationMessage,
  ConversationSessionPage,
  ConversationSessionScope,
  ConversationSessionSummary,
  ConversationSnapshot,
} from "@answra/shared";
import { foldSessionItems } from "@answra/shared/schema";
import type {
  ConversationMessageCatalog,
  ConversationMessagePage,
  ConversationMessageQuery,
  ConversationSessionCatalog,
  ConversationSessionQuery,
} from "../../catalog";
import { sessionItemMessageKey } from "../../itemStore";
import { type ConversationSessionRecord, MemoryConversationStore } from "../../memoryStore";
import type {
  ConversationSessionMetadata,
  ConversationSessionSeed,
  ConversationStoreMutation,
} from "../../store";
import { isConversationId } from "../legacySessionFiles";
import { restoreStoredSession, splitSessionRecord, summarizeSessionState } from "../sessionRecord";
import { workspaceStorageKey } from "../workspaceKey";
import { importLegacySessionFiles } from "./legacySessionImport";
import { decodeMessageCursor, encodeMessageCursor } from "./messageCursor";
import { selectMessagePage } from "./messagePage";
import { decodeSessionCursor, encodeSessionCursor } from "./sessionCursor";
import {
  deleteSessionItemRows,
  listSessionItemRows,
  readSessionItemState,
} from "./sessionItemRows";
import {
  deleteSessionRow,
  listSessionRows,
  readSessionRow,
  readSessionSummaryRow,
  SessionRecordParseError,
  type StoredSessionRow,
  writeSessionRow,
} from "./sessionRows";
import { openSessionDatabase } from "./sqliteDatabase";
import { SqliteSessionItemStore } from "./sqliteItemStore";
import { withImmediateTransaction } from "./transaction";

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const DEFAULT_MESSAGE_LIMIT = 50;
const MAX_MESSAGE_LIMIT = 200;

export class ConversationSessionCorruptError extends Error {
  readonly conversationId: string;

  constructor(conversationId: string, cause: unknown) {
    super(`会话数据损坏：${conversationId}`);
    this.name = "ConversationSessionCorruptError";
    this.conversationId = conversationId;
    this.cause = cause;
  }
}

/** SQLite transcript 适配器；条目存储与它共用同一连接，避免两套写入顺序。 */
export class SqliteConversationStore
  extends MemoryConversationStore
  implements ConversationSessionCatalog, ConversationMessageCatalog
{
  readonly items: SqliteSessionItemStore;
  private readonly db: DatabaseSync;
  private closePromise?: Promise<void>;

  constructor(root: string) {
    super();
    this.db = openSessionDatabase(root);
    this.items = new SqliteSessionItemStore(this.db);
    importLegacySessionFiles(this.db, resolve(root));
  }

  override async create(
    conversationId: string,
    seed?: ConversationSessionSeed,
    metadata?: ConversationSessionMetadata,
  ) {
    if (!metadata?.scope) throw new Error("会话创建缺少 metadata.scope");
    if (metadata.scope === "answer") return super.create(conversationId, seed, metadata);
    const existing = await this.scopeOf(conversationId);
    if (existing !== undefined && existing !== metadata.scope) {
      throw new Error("会话 scope 不匹配");
    }
    if (!this.sessions.has(conversationId)) {
      const row = this.readSession(conversationId);
      if (row !== undefined) this.restoreFromRow(row);
    }
    const snapshot = await super.create(conversationId, seed, metadata);
    await this.items.create(conversationId);
    return snapshot;
  }

  override async load(conversationId: string): Promise<ConversationSnapshot> {
    if (!this.sessions.has(conversationId)) {
      const row = this.readSession(conversationId);
      if (row === undefined) throw new Error("会话不存在");
      this.restoreFromRow(row);
    }
    return super.load(conversationId);
  }

  /** 只读 scope：不加载消息视图，用于跨领域恢复守卫。 */
  override async scopeOf(conversationId: string): Promise<ConversationSessionScope | undefined> {
    if (this.sessions.has(conversationId)) return super.scopeOf(conversationId);
    return this.readSession(conversationId)?.scope;
  }

  /** 用条目重建消息视图；恢复收口后调用，内存里有半截消息时以条目为准。 */
  override async refresh(conversationId: string): Promise<void> {
    const session = this.sessions.get(conversationId);
    if (session === undefined || session.metadata?.scope === "answer") return;
    session.snapshot = {
      ...session.snapshot,
      messages: this.foldMessages(conversationId),
      lastSeq: this.itemSequence(conversationId),
    };
  }

  /**
   * durable 游标只服务内存快照；磁盘上的事实由条目 `seq` 推导。
   * 恢复收口可能早于会话加载，此时没有内存视图可推进，直接忽略。
   */
  override async advanceLastSeq(conversationId: string, sequence: number): Promise<void> {
    if (!this.sessions.has(conversationId)) return;
    await super.advanceLastSeq(conversationId, sequence);
  }

  async list(query: ConversationSessionQuery = {}): Promise<ConversationSessionPage> {
    if (query.scope === "answer") return { items: [] };
    const limit = normalizeLimit(query.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const cursor = query.cursor === undefined ? undefined : decodeSessionCursor(query.cursor);
    const rows = listSessionRows(this.db, {
      ...(query.scope === undefined ? {} : { scope: query.scope }),
      ...(query.workspaceRoot === undefined ? {} : { workspaceRoot: query.workspaceRoot }),
      ...(cursor === undefined ? {} : { cursor }),
      limit: limit + 1,
    });
    const items: ConversationSessionSummary[] = rows.slice(0, limit).map((row) => ({
      conversationId: row.conversationId,
      scope: row.scope,
      title: row.title,
      messageCount: row.messageCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.workspaceRoot === undefined ? {} : { workspaceRoot: row.workspaceRoot }),
    }));
    const last = rows.length > limit ? rows[limit - 1] : undefined;
    return {
      items,
      ...(last !== undefined
        ? {
            nextCursor: encodeSessionCursor({
              updatedAt: last.updatedAt,
              conversationId: last.conversationId,
            }),
          }
        : {}),
    };
  }

  async getSession(
    conversationId: string,
    workspaceRoot?: string,
  ): Promise<ConversationSessionSummary | undefined> {
    if (!isConversationId(conversationId)) return undefined;
    const row = readSessionSummaryRow(this.db, conversationId);
    if (row === undefined) return undefined;
    if (workspaceRoot !== undefined) {
      if (
        row.workspaceRoot === undefined ||
        workspaceStorageKey(row.workspaceRoot) !== workspaceStorageKey(workspaceRoot)
      ) {
        return undefined;
      }
    }
    return {
      conversationId: row.conversationId,
      scope: row.scope,
      title: row.title,
      messageCount: row.messageCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.workspaceRoot === undefined ? {} : { workspaceRoot: row.workspaceRoot }),
    };
  }

  async listMessages(
    conversationId: string,
    query: ConversationMessageQuery = {},
  ): Promise<ConversationMessagePage> {
    const limit = normalizeLimit(query.limit, DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT);
    const cursor = query.cursor === undefined ? undefined : decodeMessageCursor(query.cursor);
    if (cursor && cursor.conversationId !== conversationId) throw new Error("消息游标无效");
    const row = this.readSession(conversationId);
    if (row === undefined) throw new Error("会话不存在");
    if (query.scope !== undefined && query.scope !== row.scope) {
      throw new Error("会话 scope 不匹配");
    }
    const page = selectMessagePage({
      messages: this.foldMessages(conversationId),
      sequenceById: this.messageSequences(conversationId),
      ...(cursor === undefined ? {} : { cursorSeq: cursor.seq }),
      limit,
    });
    return {
      items: page.items,
      ...(page.oldestSeq === undefined
        ? {}
        : {
            nextCursor: encodeMessageCursor({
              conversationId,
              seq: page.oldestSeq,
            }),
          }),
    };
  }

  async delete(conversationId: string): Promise<void> {
    if (!isConversationId(conversationId)) throw new Error("会话 ID 无效");
    const session = this.sessions.get(conversationId);
    if (session?.snapshot.activeMessageId) throw new Error("当前回复尚未完成，不能删除会话");
    if (session?.metadata?.scope === "answer") {
      this.forgetSession(conversationId);
      return;
    }
    this.removeSessionRows(conversationId);
    this.forgetSession(conversationId);
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeDatabase();
    return this.closePromise;
  }

  protected override async afterMutation(
    conversationId: string,
    mutation: ConversationStoreMutation,
  ): Promise<void> {
    await super.afterMutation(conversationId, mutation);
    const session = this.sessions.get(conversationId);
    if (session === undefined || session.metadata?.scope === "answer") return;
    if (mutation.kind === "cleared") {
      this.removeSessionRows(conversationId);
      return;
    }
    this.persist(session);
  }

  private async closeDatabase(): Promise<void> {
    this.db.close();
  }

  private persist(session: ConversationSessionRecord): void {
    if (session.metadata === undefined) throw new Error("会话缺少 metadata，拒绝持久化");
    const { state, messages } = splitSessionRecord(session);
    const summary = summarizeSessionState(messages, session.metadata.title);
    const input = {
      state,
      scope: session.metadata.scope,
      ...(session.metadata.workspaceRoot === undefined
        ? {}
        : { workspaceRoot: session.metadata.workspaceRoot }),
      title: summary.title,
      messageCount: summary.messageCount,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
    withImmediateTransaction(this.db, () => {
      writeSessionRow(this.db, input);
    });
  }

  /** 删会话行与条目；条目显式删除，不依赖连接级 `foreign_keys` 开关。 */
  private removeSessionRows(conversationId: string): void {
    withImmediateTransaction(this.db, () => {
      deleteSessionItemRows(this.db, conversationId);
      deleteSessionRow(this.db, conversationId);
    });
  }

  private foldMessages(conversationId: string): ConversationMessage[] {
    const state = readSessionItemState(this.db, conversationId);
    return foldSessionItems(listSessionItemRows(this.db, conversationId), {
      ...(state?.openTurnId === undefined ? {} : { openTurnId: state.openTurnId }),
    });
  }

  /** 消息 id → 首次出现的条目 `seq`；分页游标按条目序而不是快照下标。 */
  private messageSequences(conversationId: string): Map<string, number> {
    const sequences = new Map<string, number>();
    for (const item of listSessionItemRows(this.db, conversationId)) {
      const key = sessionItemMessageKey(item) ?? item.itemId;
      if (!sequences.has(key)) sequences.set(key, item.seq);
    }
    return sequences;
  }

  private itemSequence(conversationId: string): number {
    const state = readSessionItemState(this.db, conversationId);
    return state === undefined ? 0 : state.nextSeq - 1;
  }

  private readSession(conversationId: string): StoredSessionRow | undefined {
    try {
      return readSessionRow(this.db, conversationId);
    } catch (error) {
      if (error instanceof SessionRecordParseError) {
        throw new ConversationSessionCorruptError(conversationId, error);
      }
      throw error;
    }
  }

  private restoreFromRow(row: StoredSessionRow): void {
    const record = restoreStoredSession({
      state: row.state,
      messages: this.foldMessages(row.conversationId),
      metadata: {
        scope: row.scope,
        ...(row.workspaceRoot === undefined ? {} : { workspaceRoot: row.workspaceRoot }),
        title: row.title,
      },
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
    record.snapshot = { ...record.snapshot, lastSeq: this.itemSequence(row.conversationId) };
    this.restoreSession(record);
  }

  private forgetSession(conversationId: string): void {
    this.sessions.delete(conversationId);
  }
}

function normalizeLimit(limit: number | undefined, fallback: number, maximum: number): number {
  if (limit === undefined) return fallback;
  return Math.min(maximum, Math.max(1, Math.trunc(limit)));
}
