import type { PendingAuth } from "./pendingAuth";
import { readEncryptedJson, removeEncryptedFile, writeEncryptedJson } from "./secureFile";

/**
 * 待处理登录的持久化（`userData/desktop-auth-pending.bin`）。
 *
 * 为什么必须落盘：打包版的回跳是「深链 → 系统拉起新进程」。
 * 如果应用当时没在运行（或 macOS 冷启动），新进程内存里没有任何待处理状态，
 * 只靠内存会在最关键的冷启动路径上拒绝回调。落盘后由 `AuthService.restore()` 载入，
 * TTL（2 分钟）仍在消费时校验。
 *
 * 保存内容含一次性 `code_verifier`，因此同样走 safeStorage 加密。
 */

const PENDING_FILE = "desktop-auth-pending.bin";

export interface PendingAuthStore {
  load(): Promise<PendingAuth | null>;
  save(pending: PendingAuth): Promise<void>;
  clear(): Promise<void>;
}

export class FilePendingAuthStore implements PendingAuthStore {
  constructor(private readonly configDir: string) {}

  load(): Promise<PendingAuth | null> {
    return readEncryptedJson(this.configDir, PENDING_FILE, parsePending);
  }

  save(pending: PendingAuth): Promise<void> {
    return writeEncryptedJson(this.configDir, PENDING_FILE, pending);
  }

  clear(): Promise<void> {
    return removeEncryptedFile(this.configDir, PENDING_FILE);
  }
}

function parsePending(value: unknown): PendingAuth | null {
  if (typeof value !== "object" || value === null) return null;
  const pending = value as Partial<PendingAuth>;
  if (
    typeof pending.state !== "string" ||
    typeof pending.verifier !== "string" ||
    typeof pending.redirectUri !== "string" ||
    typeof pending.createdAt !== "number"
  ) {
    return null;
  }
  return {
    state: pending.state,
    verifier: pending.verifier,
    redirectUri: pending.redirectUri,
    createdAt: pending.createdAt,
  };
}
