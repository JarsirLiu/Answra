import type { AgentConnectionState } from "../schema/connection";

export type { AgentConnectionReason, AgentConnectionState } from "../schema/connection";

/** Agent 连接状态的桌面 IPC 频道；CLI 等客户端只复用 schema，不复用 Electron 频道。 */
export const ConnectionChannels = {
  GetState: "answra:connection:get-state",
  StateChanged: "answra:connection:state-changed",
} as const;

export interface ConnectionChannelMap {
  [ConnectionChannels.GetState]: { request: undefined; response: AgentConnectionState };
  [ConnectionChannels.StateChanged]: { request: undefined; response: AgentConnectionState };
}
