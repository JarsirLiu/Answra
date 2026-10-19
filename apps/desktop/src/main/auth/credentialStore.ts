import type { AuthAccountInfo, AuthQuotaInfo } from "@answra/shared";
import { readEncryptedJson, removeEncryptedFile, writeEncryptedJson } from "./secureFile";

/**
 * 登录凭据持久化（`userData/desktop-auth.bin`，OS 级加密后的 JSON）。
 *
 * 与本地模型时代的 `conversation-model.json` 同一模式：只在 `safeStorage` 可用时落盘，
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

/**
 * 服务端声明的一条云端能力端点（`GET /api/v1/capabilities` 的 `endpoints[]` 原样保存）。
 *
 * 客户端不解释 path/model 的含义，只按 `id` 取用：路径与占位模型由服务端决定，
 * 服务端升级后重新拉一次目录即可生效，不需要发布客户端。
 */
export interface AuthCapabilityEndpoint {
  id: string;
  path: string;
  model: string;
}

/** 凭据 + 服务端下发的账号画像（画像非 secret，但一并加密保存以免多一份明文文件）。 */
export interface AuthSessionRecord extends AuthTokens {
  plan: string | null;
  /** 账号展示信息；老版本记录或拉取失败时为 null。 */
  account?: AuthAccountInfo | null;
  /** 套餐额度快照；无有效套餐或老版本记录时为 null。 */
  quota?: AuthQuotaInfo | null;
  capabilities: string[];
  /** 云端能力端点；旧记录或目录拉取失败时为空数组，模型调用据此判定不可用。 */
  endpoints: AuthCapabilityEndpoint[];
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
    account: parseAccount(record.account),
    quota: parseQuota(record.quota),
    capabilities: Array.isArray(record.capabilities)
      ? record.capabilities.filter((id): id is string => typeof id === "string")
      : [],
    endpoints: parseEndpoints(record.endpoints),
  };
}

function parseAccount(value: unknown): AuthAccountInfo | null {
  if (typeof value !== "object" || value === null) return null;
  const account = value as Partial<AuthAccountInfo>;
  const email = typeof account.email === "string" ? account.email : null;
  const username = typeof account.username === "string" ? account.username : null;
  if (!email && !username) return null;
  return { email, username };
}

function parseQuota(value: unknown): AuthQuotaInfo | null {
  if (typeof value !== "object" || value === null) return null;
  const quota = value as Partial<AuthQuotaInfo>;
  return {
    usedPercent: typeof quota.usedPercent === "number" ? quota.usedPercent : null,
    expiresAt: typeof quota.expiresAt === "string" ? quota.expiresAt : null,
    daysRemaining: typeof quota.daysRemaining === "number" ? quota.daysRemaining : null,
  };
}

function parseEndpoints(value: unknown): AuthCapabilityEndpoint[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): AuthCapabilityEndpoint[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const endpoint = entry as Partial<AuthCapabilityEndpoint>;
    if (
      typeof endpoint.id !== "string" ||
      typeof endpoint.path !== "string" ||
      typeof endpoint.model !== "string"
    )
      return [];
    return [{ id: endpoint.id, path: endpoint.path, model: endpoint.model }];
  });
}
