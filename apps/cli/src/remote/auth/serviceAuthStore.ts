/** CLI 服务准入凭据端口；实现必须把 token 放进 OS keychain，不放普通文件。 */
export interface ServiceAuthRecord {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  account: string | null;
}

export interface ServiceAuthStore {
  read(): Promise<ServiceAuthRecord | null>;
  write(record: ServiceAuthRecord): Promise<void>;
  clear(): Promise<void>;
}

export function parseServiceAuthRecord(value: unknown): ServiceAuthRecord {
  if (typeof value !== "object" || value === null) throw new Error("服务登录凭据格式无效。");
  const record = value as Record<string, unknown>;
  if (typeof record.accessToken !== "string" || record.accessToken === "") {
    throw new Error("服务登录凭据缺少 access token。");
  }
  if (typeof record.refreshToken !== "string" || record.refreshToken === "") {
    throw new Error("服务登录凭据缺少 refresh token。");
  }
  if (typeof record.expiresAt !== "number" || !Number.isFinite(record.expiresAt)) {
    throw new Error("服务登录凭据的过期时间无效。");
  }
  return {
    accessToken: record.accessToken,
    refreshToken: record.refreshToken,
    expiresAt: record.expiresAt,
    account: typeof record.account === "string" && record.account !== "" ? record.account : null,
  };
}
