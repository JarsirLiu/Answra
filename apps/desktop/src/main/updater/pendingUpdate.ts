/**
 * 待安装更新的持久化记录（仅 Windows 打包版使用）。
 *
 * 更新在后台下载完成后只落一条记录，真正的安装推迟到下一次启动，
 * 避免“关闭 App 后立刻关机”打断 NSIS 的覆盖安装。
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PendingUpdate {
  /** 待安装版本（来自 `update-downloaded` 事件）。 */
  version: string;
  /** electron-updater 缓存的安装包绝对路径。 */
  installerPath: string;
}

const PENDING_UPDATE_FILE = "pending-update.json";
const VERSION_PATTERN = /^(\d+(?:\.\d+)*)(?:[-+].*)?$/;

export function pendingUpdateMarkerPath(configDir: string): string {
  return join(configDir, PENDING_UPDATE_FILE);
}

/** 读取记录；文件缺失或格式不完整返回 null，调用方按“没有待安装更新”处理。 */
export function readPendingUpdate(markerPath: string): PendingUpdate | null {
  if (!existsSync(markerPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const version = record.version;
  const installerPath = record.installerPath;
  if (typeof version !== "string" || !version) return null;
  if (typeof installerPath !== "string" || !installerPath) return null;
  return { version, installerPath };
}

export function writePendingUpdate(markerPath: string, pending: PendingUpdate): void {
  writeFileSync(markerPath, JSON.stringify(pending), "utf8");
}

export function clearPendingUpdate(markerPath: string): void {
  rmSync(markerPath, { force: true });
}

/** 候选版本是否严格新于当前版本；无法解析时返回 false（不冒进安装）。 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const next = parseVersion(candidate);
  const installed = parseVersion(current);
  if (!next || !installed) return false;
  const length = Math.max(next.length, installed.length);
  for (let index = 0; index < length; index += 1) {
    const a = next[index] ?? 0;
    const b = installed[index] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

function parseVersion(value: string): number[] | null {
  const match = VERSION_PATTERN.exec(value.trim());
  const core = match?.[1];
  if (!core) return null;
  return core.split(".").map((part) => Number.parseInt(part, 10));
}
