import type { RemoteRole, SignalingPeer } from "@answra/shared/schema";
import type { SignalingChannel } from "../ports/signalingChannel";

export const REMOTE_SIGNALING_JOIN_TIMEOUT_MS = 10_000;

export type RemoteSignalingState = "idle" | "joining" | "waiting" | "ready" | "closed";

/** 信令状态机只依赖计时器端口；Node/浏览器在组合根注入。 */
export interface RemoteSignalingTimers {
  after(delayMs: number, callback: () => void): () => void;
}

export interface RemoteSignalingSessionOptions {
  channel: SignalingChannel;
  roomId: string;
  peerId: string;
  role: RemoteRole;
  timers: RemoteSignalingTimers;
  joinTimeoutMs?: number;
}

export interface RemoteSignalingJoined {
  roomId: string;
  peerId: string;
  role: RemoteRole;
  peers: readonly SignalingPeer[];
}
