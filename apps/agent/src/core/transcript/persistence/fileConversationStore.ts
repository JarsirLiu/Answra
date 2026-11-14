import { readdir, readFile, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { ConversationSessionSummary, ConversationSnapshot } from "@answra/shared";
import type { ConversationSessionCatalog, ConversationSessionQuery } from "../catalog";
import { type ConversationSessionRecord, MemoryConversationStore } from "../memoryStore";
import type {
  ConversationSessionMetadata,
  ConversationSessionSeed,
  ConversationStoreMutation,
} from "../store";
import { writeJsonAtomically } from "./atomicFile";
import {
  parseFileSessionRecord,
  summarizeFileSessionRecord,
  toFileSessionRecord,
  toSessionRecord,
} from "./fileSessionRecord";
import {
  conversationFilePath,
  corruptFilePath,
  ensureSessionRoot,
  isConversationId,
  isSessionFileName,
} from "./sessionFilePaths";

export class ConversationSessionCorruptError extends Error {
  readonly conversationId: string;

  constructor(conversationId: string, cause: unknown) {
    super(`会话文件损坏：${conversationId}`);
    this.name = "ConversationSessionCorruptError";
    this.conversationId = conversationId;
    this.cause = cause;
  }
}

/** 文件适配器：内存工作集 + run 边界写穿；不包含产品策略或 UI 逻辑。 */
export class FileConversationStore
  extends MemoryConversationStore
  implements ConversationSessionCatalog
{
  private readonly root: string;
  private readonly writes = new Map<string, Promise<void>>();

  constructor(root: string) {
    super();
    this.root = resolve(root);
  }

  override async create(
    conversationId: string,
    seed?: ConversationSessionSeed,
    metadata?: ConversationSessionMetadata,
  ) {
    if (!metadata?.scope) throw new Error("会话创建缺少 metadata.scope");
    if (metadata.scope === "answer") {
      return super.create(conversationId, seed, metadata);
    }
    const current = this.sessions.get(conversationId);
    let existing: ConversationSessionRecord | undefined = current;
    if (!existing) existing = await this.tryReadRecord(conversationId);
    if (existing && existing.metadata?.scope !== metadata.scope) {
      throw new Error("会话 scope 不匹配");
    }
    if (!current && existing) this.restoreSession(existing);
    return super.create(conversationId, seed, metadata);
  }

  override async load(conversationId: string): Promise<ConversationSnapshot> {
    const current = this.sessions.get(conversationId);
    if (current?.metadata?.scope === "answer") return super.load(conversationId);
    if (current) return super.load(conversationId);
    try {
      const record = await this.readRecord(conversationId);
      this.restoreSession(record);
    } catch (error) {
      if (isMissingFile(error)) throw new Error("会话不存在");
      throw error;
    }
    return super.load(conversationId);
  }

  async list(query: ConversationSessionQuery = {}): Promise<readonly ConversationSessionSummary[]> {
    const base = await ensureSessionRoot(this.root);
    const names = await readdir(base);
    const summaries: ConversationSessionSummary[] = [];
    for (const name of names) {
      if (!isSessionFileName(name)) continue;
      const conversationId = name.slice(0, -5);
      try {
        const record = await this.readFileRecord(conversationId);
        summaries.push(summarizeFileSessionRecord(record));
      } catch (error) {
        if (error instanceof ConversationSessionCorruptError) {
          await this.quarantine(conversationFilePath(this.root, conversationId));
          continue;
        }
        if (isMissingFile(error)) continue;
        throw error;
      }
    }
    const filtered = summaries.filter(
      (summary) =>
        (query.scope === undefined || summary.scope === query.scope) &&
        (query.workspaceRoot === undefined || summary.workspaceRoot === query.workspaceRoot),
    );
    filtered.sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.conversationId.localeCompare(right.conversationId),
    );
    return query.limit === undefined ? filtered : filtered.slice(0, Math.max(0, query.limit));
  }

  async delete(conversationId: string): Promise<void> {
    if (!isConversationId(conversationId)) throw new Error("会话 ID 无效");
    const session = this.sessions.get(conversationId);
    if (session?.snapshot.activeRunId) throw new Error("当前回复尚未完成，不能删除会话");
    if (session?.metadata?.scope === "answer") {
      this.sessions.delete(conversationId);
      return;
    }
    await rm(conversationFilePath(this.root, conversationId), { force: true });
    this.sessions.delete(conversationId);
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
    const payload = structuredClone(toFileSessionRecord(session));
    const filePath = conversationFilePath(this.root, conversationId);
    await this.enqueueWrite(conversationId, () => writeJsonAtomically(filePath, payload));
  }

  private async enqueueWrite(conversationId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.writes.get(conversationId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    this.writes.set(conversationId, next);
    try {
      await next;
    } finally {
      if (this.writes.get(conversationId) === next) this.writes.delete(conversationId);
    }
  }

  private async tryReadRecord(
    conversationId: string,
  ): Promise<ConversationSessionRecord | undefined> {
    try {
      return await this.readRecord(conversationId);
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }

  private async readRecord(conversationId: string): Promise<ConversationSessionRecord> {
    const record = await this.readFileRecord(conversationId);
    return toSessionRecord(record);
  }

  private async readFileRecord(conversationId: string) {
    const filePath = conversationFilePath(this.root, conversationId);
    const raw = await readFile(filePath, "utf8");
    try {
      const record = parseFileSessionRecord(JSON.parse(raw));
      if (record.conversationId !== conversationId) {
        throw new Error("文件内的会话 ID 与文件名不一致");
      }
      return record;
    } catch (error) {
      throw new ConversationSessionCorruptError(conversationId, error);
    }
  }

  private async quarantine(filePath: string): Promise<void> {
    await rename(filePath, corruptFilePath(filePath)).catch(() => {});
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
