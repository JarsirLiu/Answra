/** 旧 JSON 会话文件一次性导入 SQLite；不参与运行时读写。 */
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { archiveLegacySessionFile, listLegacySessionFiles } from "../legacySessionFiles";
import {
  parseSessionRecord,
  splitLegacySessionRecord,
  summarizeSessionRecord,
} from "../sessionRecord";
import { insertMessageRow, insertSessionRow } from "./sessionRows";
import { withImmediateTransaction } from "./transaction";

const LEGACY_IMPORT_MARKER_PREFIX = "legacy-import:";

export interface LegacyImportResult {
  imported: number;
  quarantined: number;
  failed: number;
}

export function importLegacySessionFiles(db: DatabaseSync, root: string): LegacyImportResult {
  const marker = `${LEGACY_IMPORT_MARKER_PREFIX}${resolve(root)}`;
  if (hasMeta(db, marker)) return { imported: 0, quarantined: 0, failed: 0 };

  const result: LegacyImportResult = { imported: 0, quarantined: 0, failed: 0 };
  for (const filePath of listLegacySessionFiles(root)) {
    const name = basename(filePath, ".json");
    let payload: ReturnType<typeof parseSessionRecord>;
    try {
      payload = parseSessionRecord(JSON.parse(readFileSync(filePath, "utf8")));
      if (payload.conversationId !== name) throw new Error("文件内会话 ID 与文件名不一致");
    } catch {
      archiveLegacySessionFile(root, filePath, true);
      result.quarantined += 1;
      continue;
    }
    if (payload.scope === "answer") {
      archiveLegacySessionFile(root, filePath, false);
      continue;
    }
    if (hasSessionRow(db, payload.conversationId)) {
      archiveLegacySessionFile(root, filePath, false);
      continue;
    }
    try {
      withImmediateTransaction(db, () => insertLegacyRecord(db, payload));
    } catch {
      // 保留文件等待下次启动重试；写库失败不等于文件损坏。
      result.failed += 1;
      continue;
    }
    archiveLegacySessionFile(root, filePath, false);
    result.imported += 1;
  }
  if (result.failed === 0) writeMeta(db, marker, new Date().toISOString());
  return result;
}

function insertLegacyRecord(
  db: DatabaseSync,
  payload: ReturnType<typeof parseSessionRecord>,
): void {
  const { state, messages } = splitLegacySessionRecord(payload);
  const ids = new Set<string>();
  for (const message of messages) {
    if (ids.has(message.id)) throw new Error(`消息 ID 重复：${message.id}`);
    ids.add(message.id);
  }
  const summary = summarizeSessionRecord(payload);
  insertSessionRow(
    db,
    {
      state,
      scope: summary.scope,
      ...(summary.workspaceRoot === undefined ? {} : { workspaceRoot: summary.workspaceRoot }),
      title: summary.title,
      messageCount: summary.messageCount,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
    },
    0,
  );
  messages.forEach((message, index) => {
    insertMessageRow(db, payload.conversationId, index + 1, message);
  });
}

function hasSessionRow(db: DatabaseSync, conversationId: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sessions WHERE conversation_id = ?").get(conversationId) !== undefined
  );
}

function hasMeta(db: DatabaseSync, key: string): boolean {
  return db.prepare("SELECT 1 FROM meta WHERE key = ?").get(key) !== undefined;
}

function writeMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
}
