import type { SignalingFrame } from "@answra/shared/schema";
import type { Unsubscribe } from "./subscription";

export type SignalingChannelState = "connecting" | "open" | "closed";

/** 控制面只传房间、SDP 与 ICE；不传业务消息。 */
export interface SignalingChannel {
  state(): SignalingChannelState;
  send(frame: SignalingFrame): void;
  close(reason?: string): void;
  onFrame(listener: (frame: SignalingFrame) => void): Unsubscribe;
  onState(listener: (state: SignalingChannelState) => void): Unsubscribe;
}
