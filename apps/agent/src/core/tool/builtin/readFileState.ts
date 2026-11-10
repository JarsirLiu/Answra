/** 会话级文件读取状态：Read 的缓存键、Edit 的读前校验与写后回填；不读写文件系统。 */
import path from "node:path";
import type { ReadFileStateEntry, ReadFileStateMap } from "../contracts";

export const FULL_FILE_OFFSET = 1;

export function createReadFileStateKey(
  filePath: string,
  offset: number,
  limit: number | undefined,
): string {
  return [
    readStatePathKey(filePath),
    String(offset),
    limit === undefined ? "" : String(limit),
  ].join("\0");
}

export function isCachedReadFresh(
  entry: ReadFileStateEntry,
  stat: { readonly mtimeMs: number; readonly sizeBytes: number },
): boolean {
  return entry.origin === "read" && !entry.partialView && matchesFileStat(entry, stat);
}

export function matchesFileStat(
  entry: ReadFileStateEntry,
  stat: { readonly mtimeMs: number; readonly sizeBytes: number },
): boolean {
  return entry.mtimeMs === Math.trunc(stat.mtimeMs) && entry.sizeBytes === stat.sizeBytes;
}

/** 最近一次完整读取或编辑基线；partial view 不能作为编辑依据。 */
export function findReadFileStateForEdit(
  state: ReadFileStateMap,
  filePath: string,
): ReadFileStateEntry | undefined {
  const pathKey = readStatePathKey(filePath);
  let latest: ReadFileStateEntry | undefined;
  for (const entry of state.values()) {
    if (!entry.partialView && readStatePathKey(entry.path) === pathKey) latest = entry;
  }
  return latest;
}

/** 文件内容改变后，旧的范围缓存全部失效。 */
export function clearReadFileStatesForPath(state: ReadFileStateMap, filePath: string): void {
  const pathKey = readStatePathKey(filePath);
  for (const [key, entry] of state) {
    if (key.startsWith(`${pathKey}\0`) || readStatePathKey(entry.path) === pathKey) {
      state.delete(key);
    }
  }
}

/**
 * 写回成功后记录整文件基线。origin=edit 让再次编辑免于强制 Read，
 * 但下一次 Read 仍会返回新内容，而不是 file_unchanged。
 */
export function recordEditedFileState(
  state: ReadFileStateMap,
  input: { path: string; mtimeMs: number; sizeBytes: number },
): void {
  state.set(createReadFileStateKey(input.path, FULL_FILE_OFFSET, undefined), {
    limit: undefined,
    mtimeMs: Math.trunc(input.mtimeMs),
    offset: FULL_FILE_OFFSET,
    origin: "edit",
    partialView: false,
    path: input.path,
    sizeBytes: input.sizeBytes,
  });
}

function readStatePathKey(filePath: string): string {
  const normalized = path.resolve(filePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
