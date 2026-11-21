import type { RemoteCredentialRecord } from "@answra/remote";
import type { RemoteErrorCode } from "@answra/shared/schema";

export const DEFAULT_HOST_LABEL = "未命名电脑";

/** host 列表视图模型；只含非 secret 元数据，完整连接码留在 SecureStore。 */
export interface HostSummary {
  readonly keyId: string;
  readonly roomId: string;
  readonly label: string;
  readonly lastConnectedAt: string | null;
  readonly lastErrorCode: RemoteErrorCode | null;
}

export function createHostSummary(record: RemoteCredentialRecord): HostSummary {
  return {
    keyId: record.keyId,
    roomId: record.roomId,
    label: record.label ?? DEFAULT_HOST_LABEL,
    lastConnectedAt: record.lastUsedAt ?? null,
    lastErrorCode: null,
  };
}

export function markHostConnected(summary: HostSummary, connectedAt: string): HostSummary {
  return { ...summary, lastConnectedAt: connectedAt, lastErrorCode: null };
}

export function markHostError(summary: HostSummary, errorCode: RemoteErrorCode): HostSummary {
  return { ...summary, lastErrorCode: errorCode };
}
