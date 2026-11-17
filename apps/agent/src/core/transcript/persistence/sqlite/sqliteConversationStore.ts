import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
  ConversationSessionPage,
  ConversationSessionSummary,
  ConversationSnapshot,
} from "@answra/shared";
import type { ConversationSessionCatalog, ConversationSessionQuery } from "../../catalog";
import { MemoryConversationStore } from "../../memoryStore";
import type {
  ConversationSessionMetadata,
  ConversationSessionSeed,
  ConversationStoreMutation,
} from "../../store";
import { isConversationId } from "../legacySessionFiles";
import { toConversationSessionRecord, toSessionRecordPayload } from "../sessionRecord";
import { importLegacySessionFiles } from "./legacySessionImport";
import { decodeSessionCursor, encodeSessionCursor } from "./sessionCursor";
import {
  backfillSessionSummaries,
  deleteSessionRow,
  insertSessionRow,
  listSessionRows,
  parseStoredRecord,
  quarantineSessionRow,
  readSessionRow,
  SessionRecordParseError,
  type StoredSessionRow,
  updateSessionRow,
} from "./sessionRows";
import { openSessionDatabase, withImmediateTransaction } from "./sqliteDatabase";

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

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
  implements ConversationSessionCatalog
{
  private readonly db: DatabaseSync;
  private readonly revisions = new Map<string, number>();
  private readonly writes = new Map<string, Promise<void>>();

  constructor(root: string) {
    super();
    this.db = openSessionDatabase(root);
    importLegacySessionFiles(this.db, resolve(root));
    backfillSessionSummaries(this.db);
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
    const stored = this.readSession(conversationId);
    if (stored) {
      if (stored.record.scope !== metadata.scope) throw new Error("会话 scope 不匹配");
      this.restoreStoredSession(stored);
    }
    return super.create(conversationId, seed, metadata);
  }

  override async load(conversationId: string): Promise<ConversationSnapshot> {
    const current = this.sessions.get(conversationId);
    if (current?.metadata?.scope === "answer") return super.load(conversationId);
    if (current) return super.load(conversationId);
    const stored = this.readSession(conversationId);
    if (!stored) throw new Error("会话不存在");
    this.restoreStoredSession(stored);
    return super.load(conversationId);
  }

  async list(query: ConversationSessionQuery = {}): Promise<ConversationSessionPage> {
    if (query.scope === "answer") return { items: [] };
    const limit = normalizeLimit(query.limit);
    const cursor = query.cursor === undefined ? undefined : decodeSessionCursor(query.cursor);
    const rows = listSessionRows(this.db, {
      ...(query.scope === undefined ? {} : { scope: query.scope }),
      ...(query.workspaceRoot === undefined ? {} : { workspaceRoot: query.workspaceRoot }),
      ...(cursor === undefined ? {} : { cursor }),
      limit: limit + 1,
    });
    const items: ConversationSessionSummary[] = [];
    for (const row of rows.slice(0, limit)) {
      try {
        parseStoredRecord(row.conversationId, row.recordJson);
      } catch (error) {
        if (!(error instanceof SessionRecordParseError)) throw error;
        this.quarantine(row.conversationId, row.recordJson, error);
        continue;
      }
      items.push({
        conversationId: row.conversationId,
        scope: row.scope,
        title: row.title ?? "未命名会话",
        messageCount: row.messageCount,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        ...(row.workspaceRoot === undefined ? {} : { workspaceRoot: row.workspaceRoot }),
      });
    }
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

  async delete(conversationId: string): Promise<void> {
    if (!isConversationId(conversationId)) throw new Error("会话 ID 无效");
    const session = this.sessions.get(conversationId);
    if (session?.snapshot.activeRunId) throw new Error("当前回复尚未完成，不能删除会话");
    if (session?.metadata?.scope === "answer") {
      this.sessions.delete(conversationId);
      return;
    }
    await (this.writes.get(conversationId) ?? Promise.resolve());
    withImmediateTransaction(this.db, () => deleteSessionRow(this.db, conversationId));
    this.sessions.delete(conversationId);
    this.revisions.delete(conversationId);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.writes.values()]);
    this.db.close();
  }

  protected override async afterMutation(
    conversationId: string,
    mutation: ConversationStoreMutation,
  ): Promise<void> {
    await super.afterMutation(conversationId, mutation);
    if (this.sessions.get(conversationId)?.metadata?.scope === "answer") return;
    await this.persist(conversationId);
  }

  private async persist(conversationId: string): Promise<void> {
    const session = this.sessions.get(conversationId);
    if (!session || session.metadata?.scope === "answer") return;
    const payload = structuredClone(toSessionRecordPayload(session));
    await this.enqueueWrite(conversationId, () => {
      const expected = this.revisions.get(conversationId);
      try {
        withImmediateTransaction(this.db, () => {
          const changes =
            expected === undefined
              ? insertSessionRow(this.db, payload, 0)
              : updateSessionRow(this.db, payload, expected);
          if (changes !== 1) throw new ConversationSessionConflictError(conversationId);
        });
      } catch (error) {
        if (error instanceof ConversationSessionConflictError) {
          this.sessions.delete(conversationId);
          this.revisions.delete(conversationId);
        }
        throw error;
      }
      this.revisions.set(conversationId, expected === undefined ? 0 : expected + 1);
    });
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

  private restoreStoredSession(stored: StoredSessionRow): void {
    this.restoreSession(toConversationSessionRecord(stored.record));
    this.revisions.set(stored.conversationId, stored.revision);
  }

  private quarantine(conversationId: string, recordJson: string, error: unknown): void {
    withImmediateTransaction(this.db, () =>
      quarantineSessionRow(this.db, conversationId, recordJson, describeError(error)),
    );
    this.revisions.delete(conversationId);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIST_LIMIT;
  return Math.min(MAX_LIST_LIMIT, Math.max(1, Math.trunc(limit)));
}
