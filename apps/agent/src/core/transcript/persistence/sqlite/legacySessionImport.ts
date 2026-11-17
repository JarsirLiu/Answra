/** 旧 JSON 会话文件一次性导入 SQLite；不参与运行时读写。 */
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { archiveLegacySessionFile, listLegacySessionFiles } from "../legacySessionFiles";
import { parseSessionRecord } from "../sessionRecord";
import { hasMeta, insertSessionRow, writeMeta } from "./sessionRows";
import { withImmediateTransaction } from "./sqliteDatabase";

const LEGACY_IMPORT_MARKER_PREFIX = "legacy-import:";

export interface LegacyImportResult {
  imported: number;
  quarantined: number;
}

export function importLegacySessionFiles(db: DatabaseSync, root: string): LegacyImportResult {
  const marker = `${LEGACY_IMPORT_MARKER_PREFIX}${resolve(root)}`;
  if (hasMeta(db, marker)) return { imported: 0, quarantined: 0 };

  const result: LegacyImportResult = { imported: 0, quarantined: 0 };
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
    withImmediateTransaction(db, () => {
      insertSessionRow(db, payload, 0);
    });
    archiveLegacySessionFile(root, filePath, false);
    result.imported += 1;
  }
  writeMeta(db, marker, new Date().toISOString());
  return result;
}
