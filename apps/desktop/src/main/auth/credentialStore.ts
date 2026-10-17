import { readEncryptedJson, removeEncryptedFile, writeEncryptedJson } from "./secureFile";

/**
 * 登录凭据持久化（`userData/desktop-auth.bin`，OS 级加密后的 JSON）。
 *
 * 与 `conversation-model.json` 里的模型 Key 同一模式：只在 `safeStorage` 可用时落盘，
 * 不可用（如 Linux 无 keyring）时**拒绝**写入，绝不明文保存 token。
 * `safeStorage` 必须在 app ready 之后调用。
 */

const CREDENTIAL_FILE = "desktop-auth.bin";

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  /** 绝对过期时间（epoch ms，已扣减安全余量）。 */
  expiresAt: number;
}

/** 凭据 + 服务端下发的账号画像（画像非 secret，但一并加密保存以免多一份明文文件）。 */
export interface AuthSessionRecord extends AuthTokens {
  plan: string | null;
  capabilities: string[];
}

export interface AuthCredentialStore {
  load(): Promise<AuthSessionRecord | null>;
  save(record: AuthSessionRecord): Promise<void>;
  clear(): Promise<void>;
}

export class FileAuthCredentialStore implements AuthCredentialStore {
  constructor(private readonly configDir: string) {}

  load(): Promise<AuthSessionRecord | null> {
    return readEncryptedJson(this.configDir, CREDENTIAL_FILE, parseRecord);
  }

  save(record: AuthSessionRecord): Promise<void> {
    return writeEncryptedJson(this.configDir, CREDENTIAL_FILE, record);
  }

  clear(): Promise<void> {
    return removeEncryptedFile(this.configDir, CREDENTIAL_FILE);
  }
}

function parseRecord(value: unknown): AuthSessionRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Partial<AuthSessionRecord>;
  if (
    typeof record.accessToken !== "string" ||
    typeof record.refreshToken !== "string" ||
    typeof record.expiresAt !== "number"
  ) {
    return null;
  }
  return {
    accessToken: record.accessToken,
    refreshToken: record.refreshToken,
    expiresAt: record.expiresAt,
    plan: typeof record.plan === "string" ? record.plan : null,
    capabilities: Array.isArray(record.capabilities)
      ? record.capabilities.filter((id): id is string => typeof id === "string")
      : [],
  };
}
