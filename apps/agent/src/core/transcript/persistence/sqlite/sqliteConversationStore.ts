/** SQLite transcript 适配器：内存工作集 + 增量消息写穿 + 活动消息草稿；不保存 Agent 事件。catalog/writer/conflict/load 待拆分。 */
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
  ConversationSessionPage,
  ConversationSessionSummary,
  ConversationSnapshot,
} from "@answra/shared";
import type { AgentEventEnvelope } from "@answra/shared/schema";
import type {
  ConversationMessageCatalog,
  ConversationMessagePage,
  ConversationMessageQuery,
  ConversationSessionCatalog,
  ConversationSessionQuery,
} from "../../catalog";
import { type ConversationSessionRecord, MemoryConversationStore } from "../../memoryStore";
import type {
  ConversationSessionMetadata,
  ConversationSessionSeed,
  ConversationStoreMutation,
} from "../../store";
import { isConversationId } from "../legacySessionFiles";
import { workspaceStorageKey } from "../workspaceKey";
import { DraftCheckpointScheduler } from "./draftCheckpoint";
import { importLegacySessionFiles } from "./legacySessionImport";
import { decodeMessageCursor, encodeMessageCursor } from "./messageCursor";
import { selectMessagePage } from "./messagePage";
import { cleanupConflictOwnedMessages } from "./sessionConflict";
import { decodeSessionCursor, encodeSessionCursor } from "./sessionCursor";
import { buildSessionRowWrite, dirtyMessages, mergeStoredSession } from "./sessionMessageMap";
import {
  bumpSessionRevision,
  deleteDraftRow,
  deleteDraftRows,
  deleteSessionRowWithRevision,
  insertMessageRow,
  insertSessionRow,
  listSessionRows,
  readSessionRevision,
  readSessionRow,
  readSessionSummaryRow,
  SessionRecordParseError,
  type StoredSessionRow,
  updateMessageRow,
  updateSessionRow,
  upsertDraftRow,
} from "./sessionRows";
import { openSessionDatabase } from "./sqliteDatabase";
import { withImmediateTransaction } from "./transaction";

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const DEFAULT_MESSAGE_LIMIT = 50;
const MAX_MESSAGE_LIMIT = 200;

export class ConversationSessionConflictError extends Error {
  readonly conversationId: string;

  constructor(conversationId: string) {
    super(`会话已被其他进程修改，请重新加载后再试：${conversationId}`);
    this.name = "ConversationSessionConflictError";
    this.conversationId = conversationId;
  }
}

export class ConversationSessionCorruptError extends Error {
  readonly conversationId: string;

  constructor(conversationId: string, cause: unknown) {
    super(`会话数据损坏：${conversationId}`);
    this.name = "ConversationSessionCorruptError";
    this.conversationId = conversationId;
    this.cause = cause;
  }
}

/** SQLite transcript 适配器：内存工作集 + 变更时事务写穿；不保存 Agent 事件。 */
export class SqliteConversationStore
  extends MemoryConversationStore
  implements ConversationSessionCatalog, ConversationMessageCatalog
{
  private readonly db: DatabaseSync;
  private readonly revisions = new Map<string, number>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly persistedMessageIds = new Map<string, Set<string>>();
  private readonly ownedMessageIds = new Map<string, Set<string>>();
  private readonly conflicted = new Set<string>();
  private readonly sequences = new Map<string, Map<string, number>>();
  private readonly nextSequences = new Map<string, number>();
  private readonly checkpoints = new DraftCheckpointScheduler({
    isTarget: (conversationId, messageId) => this.isCheckpointTarget(conversationId, messageId),
    write: (conversationId, messageId) => this.persistCheckpoint(conversationId, messageId),
  });
  private closePromise?: Promise<void>;

  constructor(root: string) {
    super();
    this.db = openSessionDatabase(root);
    importLegacySessionFiles(this.db, resolve(root));
  }

  override async create(
    conversationId: string,
    seed?: ConversationSessionSeed,
    metadata?: ConversationSessionMetadata,
  ) {
    if (!metadata?.scope) throw new Error("会话创建缺少 metadata.scope");
    if (metadata.scope === "answer") return super.create(conversationId, seed, metadata);
    const current = this.sessions.get(conversationId);
    if (current) {
      if (current.metadata?.scope !== metadata.scope) throw new Error("会话 scope 不匹配");
      return super.create(conversationId, seed, metadata);
    }
    const loaded = this.loadStoredSession(conversationId);
    if (loaded) {
      if (loaded.stored.scope !== metadata.scope) throw new Error("会话 scope 不匹配");
      this.restoreLoadedSession(loaded);
    }
    this.conflicted.delete(conversationId);
    this.ownedMessageIds.set(conversationId, new Set());
    return super.create(conversationId, seed, metadata);
  }

  override async load(conversationId: string): Promise<ConversationSnapshot> {
    const current = this.sessions.get(conversationId);
    if (current) return super.load(conversationId);
    const loaded = this.loadStoredSession(conversationId);
    if (!loaded) throw new Error("会话不存在");
    this.restoreLoadedSession(loaded);
    return super.load(conversationId);
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
    const session = this.sessions.get(conversationId);
    if (!session) await this.load(conversationId);
    const active = this.sessions.get(conversationId);
    if (!active) throw new Error("会话不存在");
    const scope = active.metadata?.scope;
    if (query.scope !== undefined && query.scope !== scope) {
      throw new Error("会话 scope 不匹配");
    }
    const snapshot = await super.load(conversationId);
    const page = selectMessagePage({
      messages: snapshot.messages,
      sequenceById: this.sequences.get(conversationId),
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
    if (this.conflicted.has(conversationId)) {
      throw new ConversationSessionConflictError(conversationId);
    }
    const session = this.sessions.get(conversationId);
    if (session?.snapshot.activeRunId) throw new Error("当前回复尚未完成，不能删除会话");
    this.checkpoints.cancel(conversationId);
    if (session?.metadata?.scope === "answer") {
      this.forgetSession(conversationId);
      return;
    }
    await this.settlePendingWrite(conversationId);
    const current = readSessionRevision(this.db, conversationId);
    if (current === undefined) {
      this.conflicted.delete(conversationId);
      this.forgetSession(conversationId);
      return;
    }
    const expected = this.revisions.get(conversationId) ?? current;
    withImmediateTransaction(this.db, () => {
      const changes = deleteSessionRowWithRevision(this.db, conversationId, expected);
      if (changes !== 1) throw new ConversationSessionConflictError(conversationId);
    });
    this.conflicted.delete(conversationId);
    this.forgetSession(conversationId);
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeDatabase();
    return this.closePromise;
  }

  override async applyAgentEvent(
    conversationId: string,
    envelope: AgentEventEnvelope,
  ): Promise<void> {
    await super.applyAgentEvent(conversationId, envelope);
    this.checkpoints.schedule(conversationId, envelope);
  }

  protected override async afterMutation(
    conversationId: string,
    mutation: ConversationStoreMutation,
  ): Promise<void> {
    if (mutation.kind === "stream-checkpoint") {
      await this.persistCheckpoint(conversationId, mutation.messageId);
      return;
    }
    await super.afterMutation(conversationId, mutation);
    const session = this.sessions.get(conversationId);
    if (!session || session.metadata?.scope === "answer") return;
    if (mutation.kind === "run-started") {
      this.checkpoints.cancel(conversationId);
    } else if (mutation.kind === "run-finished") {
      this.checkpoints.cancel(conversationId);
      await this.settlePendingWrite(conversationId);
    } else if (mutation.kind === "cleared") {
      this.checkpoints.cancel(conversationId);
    }
    await this.persist(conversationId, mutation);
  }

  private async closeDatabase(): Promise<void> {
    await this.checkpoints.close();
    await Promise.allSettled([...this.writes.values()]);
    this.db.close();
  }

  private async persist(
    conversationId: string,
    mutation: ConversationStoreMutation,
  ): Promise<void> {
    const session = this.sessions.get(conversationId);
    if (!session) return;
    if (session.metadata?.scope === "answer") return;
    if (this.conflicted.has(conversationId)) {
      throw new ConversationSessionConflictError(conversationId);
    }
    const { input, messages } = buildSessionRowWrite(session);
    const expected = this.revisions.get(conversationId);
    if (expected === undefined && messages.length === 0) return;
    const persisted = new Set(this.persistedMessageIds.get(conversationId) ?? []);
    const dirty = dirtyMessages(messages, mutation, persisted);
    const owned = new Set(this.ownedMessageIds.get(conversationId) ?? []);
    const sequences = new Map(this.sequences.get(conversationId) ?? []);
    const nextSeq = this.nextSequences.get(conversationId) ?? 1;
    let cleared = false;

    await this.enqueueWrite(conversationId, () => {
      if (this.conflicted.has(conversationId)) {
        throw new ConversationSessionConflictError(conversationId);
      }
      const nextPersisted = new Set(persisted);
      const nextOwned = new Set(owned);
      const nextSequences = new Map(sequences);
      let cursor = nextSeq;
      try {
        withImmediateTransaction(this.db, () => {
          if (mutation.kind === "cleared") {
            const changes =
              expected === undefined
                ? 0
                : deleteSessionRowWithRevision(this.db, conversationId, expected);
            if (expected !== undefined && changes !== 1) {
              throw new ConversationSessionConflictError(conversationId);
            }
            nextPersisted.clear();
            nextOwned.clear();
            nextSequences.clear();
            cursor = 1;
            cleared = true;
            return;
          }
          const changes =
            expected === undefined
              ? insertSessionRow(this.db, input, 0)
              : updateSessionRow(this.db, input, expected);
          if (changes !== 1) throw new ConversationSessionConflictError(conversationId);
          for (const message of dirty) {
            if (nextPersisted.has(message.id)) {
              updateMessageRow(this.db, conversationId, message);
              continue;
            }
            insertMessageRow(this.db, conversationId, cursor, message);
            nextPersisted.add(message.id);
            nextOwned.add(message.id);
            nextSequences.set(message.id, cursor);
            cursor += 1;
          }
          if (mutation.kind === "run-finished") {
            for (const message of dirty) {
              deleteDraftRow(this.db, conversationId, message.id);
            }
          }
        });
      } catch (error) {
        if (error instanceof ConversationSessionConflictError) {
          this.handleConflict(conversationId, owned);
        }
        throw error;
      }
      if (cleared) {
        this.clearPersistenceState(conversationId);
        return;
      }
      this.revisions.set(conversationId, expected === undefined ? 0 : expected + 1);
      this.persistedMessageIds.set(conversationId, nextPersisted);
      this.ownedMessageIds.set(conversationId, nextOwned);
      this.sequences.set(conversationId, nextSequences);
      this.nextSequences.set(conversationId, cursor);
    });
  }

  private handleConflict(conversationId: string, ownedMessageIds: ReadonlySet<string>): void {
    try {
      withImmediateTransaction(this.db, () =>
        cleanupConflictOwnedMessages(this.db, conversationId, ownedMessageIds),
      );
    } finally {
      this.checkpoints.cancel(conversationId);
      this.forgetSession(conversationId);
      this.conflicted.add(conversationId);
    }
  }

  private async persistCheckpoint(conversationId: string, messageId: string): Promise<void> {
    if (this.conflicted.has(conversationId)) return;
    if (!this.isCheckpointTarget(conversationId, messageId)) return;
    const session = this.sessions.get(conversationId);
    if (!session) return;
    const message = session.snapshot.messages.find((item) => item.id === messageId);
    if (!message) return;
    const expected = this.revisions.get(conversationId);
    if (expected === undefined) return;
    const draft = structuredClone(message);
    const updatedAt = new Date().toISOString();
    await this.enqueueWrite(conversationId, () => {
      if (!this.isCheckpointTarget(conversationId, messageId)) return;
      withImmediateTransaction(this.db, () => {
        if (readSessionRevision(this.db, conversationId) !== expected) return;
        upsertDraftRow(this.db, conversationId, draft, expected, updatedAt);
      });
    });
  }

  private isCheckpointTarget(conversationId: string, messageId: string): boolean {
    if (this.conflicted.has(conversationId)) return false;
    const session = this.sessions.get(conversationId);
    if (!session || session.metadata?.scope === "answer") return false;
    if (session.snapshot.activeRunId !== messageId) return false;
    const message = session.snapshot.messages.find((item) => item.id === messageId);
    return message?.role === "assistant" && message.status === "streaming";
  }

  private enqueueWrite(conversationId: string, task: () => void): Promise<void> {
    const previous = this.writes.get(conversationId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    this.writes.set(conversationId, next);
    return next.finally(() => {
      if (this.writes.get(conversationId) === next) this.writes.delete(conversationId);
    });
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

  private loadStoredSession(
    conversationId: string,
  ): { stored: StoredSessionRow; record: ConversationSessionRecord; revision: number } | undefined {
    return withImmediateTransaction(this.db, () => {
      const stored = this.readSession(conversationId);
      if (!stored) return undefined;
      const { record, draftMessageIds } = mergeStoredSession(stored);
      for (const row of stored.messages) {
        if (!draftMessageIds.has(row.message.id)) continue;
        const restored = record.snapshot.messages.find((message) => message.id === row.message.id);
        if (!restored) throw new Error("草稿恢复后缺少消息");
        updateMessageRow(this.db, stored.conversationId, restored);
      }
      if (stored.drafts.length > 0) deleteDraftRows(this.db, stored.conversationId);
      let revision = stored.revision;
      if (draftMessageIds.size > 0) {
        const changes = bumpSessionRevision(this.db, stored.conversationId, stored.revision);
        if (changes !== 1) throw new ConversationSessionConflictError(stored.conversationId);
        revision += 1;
      }
      return { stored, record, revision };
    });
  }

  private restoreLoadedSession(loaded: {
    stored: StoredSessionRow;
    record: ConversationSessionRecord;
    revision: number;
  }): void {
    const { stored, record, revision } = loaded;
    this.restoreSession(record);
    this.conflicted.delete(stored.conversationId);
    this.revisions.set(stored.conversationId, revision);
    this.persistedMessageIds.set(
      stored.conversationId,
      new Set(stored.messages.map((row) => row.message.id)),
    );
    this.ownedMessageIds.set(stored.conversationId, new Set());
    this.sequences.set(
      stored.conversationId,
      new Map(stored.messages.map((row) => [row.message.id, row.seq])),
    );
    const maxSeq = stored.messages.at(-1)?.seq ?? 0;
    this.nextSequences.set(stored.conversationId, maxSeq + 1);
  }

  /** 最终持久化/删除不能被前一个失败的可选 checkpoint 或正文写 promise 阻断。 */
  private async settlePendingWrite(conversationId: string): Promise<void> {
    const pending = this.writes.get(conversationId);
    if (pending) await pending.catch(() => {});
  }

  private clearPersistenceState(conversationId: string): void {
    this.revisions.delete(conversationId);
    this.persistedMessageIds.delete(conversationId);
    this.ownedMessageIds.delete(conversationId);
    this.sequences.delete(conversationId);
    this.nextSequences.delete(conversationId);
  }

  private forgetSession(conversationId: string): void {
    this.sessions.delete(conversationId);
    this.clearPersistenceState(conversationId);
  }
}

function normalizeLimit(limit: number | undefined, fallback: number, maximum: number): number {
  if (limit === undefined) return fallback;
  return Math.min(maximum, Math.max(1, Math.trunc(limit)));
}
