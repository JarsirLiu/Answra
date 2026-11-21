/** 桌面 host 远程控制频道；密钥明文只经创建响应返回一次，不进入状态推送。 */
export const RemoteHostChannels = {
  GetStatus: "answra:remote:get-status",
  Connect: "answra:remote:connect",
  Disconnect: "answra:remote:disconnect",
  Status: "answra:remote:status",
} as const;

export type RemoteHostState =
  | "stopped"
  | "starting"
  | "waiting"
  | "ready"
  | "reconnecting"
  | "interrupted";

export interface RemoteHostKeySummary {
  keyId: string;
  label?: string;
  createdAt: string;
  expiresAt?: string;
}

export interface RemoteHostStatus {
  running: boolean;
  state: RemoteHostState;
  key: RemoteHostKeySummary | null;
  statusLine: string | null;
  lastError: string | null;
}

export interface RemoteHostKeyCreation {
  key: string;
  keyId: string;
  expiresAt?: string;
}

export interface RemoteHostConnectResult {
  key: RemoteHostKeyCreation;
  status: RemoteHostStatus;
}

export interface RemoteHostChannelMap {
  [RemoteHostChannels.GetStatus]: { request: undefined; response: RemoteHostStatus };
  [RemoteHostChannels.Connect]: { request: undefined; response: RemoteHostConnectResult };
  [RemoteHostChannels.Disconnect]: { request: undefined; response: RemoteHostStatus };
  [RemoteHostChannels.Status]: { request: undefined; response: RemoteHostStatus };
}
