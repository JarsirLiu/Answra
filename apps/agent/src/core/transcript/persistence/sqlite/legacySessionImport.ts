/** 旧 JSON 会话文件一次性导入 SQLite；不参与运行时读写。 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { archiveLegacySessionFile, listLegacySessionFiles } from "../legacySessionFiles";
import {
  parseSessionRecord,
  splitLegacySessionRecord,
  summarizeSessionRecord,
} from "../sessionRecord";
import { legacyMessagesToItems } from "./legacyMessageItems";
import { insertSessionItemRow, writeSessionItemState } from "./sessionItemRows";
import { writeSessionRow } from "./sessionRows";
import { withImmediateTransaction } from "./transaction";

export interface LegacyImportResult {
  imported: number;
  quarantined: number;
  failed: number;
}

/**
 * 幂等来源是两个事实：导入成功的文件已移入 `legacy/` 子目录，因而不再出现在根目录扫描结果里；
 * 同名会话行已存在时按重复文件归档。因此不需要额外的导入标记表。
 */
export function importLegacySessionFiles(db: DatabaseSync, root: string): LegacyImportResult {
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
  writeSessionRow(db, {
    state,
    scope: summary.scope,
    ...(summary.workspaceRoot === undefined ? {} : { workspaceRoot: summary.workspaceRoot }),
    title: summary.title,
    messageCount: 0,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
  });
  // 导入必须直接写条目：迁移回填只处理 `session_messages`，且发布后已冻结。
  const converted = legacyMessagesToItems(messages, toIsoTimestamp(summary.updatedAt));
  let seq = 0;
  for (const draft of converted.items) {
    seq += 1;
    insertSessionItemRow(db, payload.conversationId, { ...draft, seq });
  }
  writeSessionItemState(db, payload.conversationId, {
    nextSeq: seq + 1,
    messageCount: converted.messageCount,
  });
}

function hasSessionRow(db: DatabaseSync, conversationId: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sessions WHERE conversation_id = ?").get(conversationId) !== undefined
  );
}

function toIsoTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`会话时间戳无效：${value}`);
  return parsed.toISOString();
}
