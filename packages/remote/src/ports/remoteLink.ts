import type { RemoteFrame } from "@answra/shared/schema";
import type { Unsubscribe } from "./subscription";

/** 数据面链路状态；具体 WebRTC/内存实现由宿主注入。 */
export type RemoteLinkState = "connecting" | "open" | "closed";

/** 只负责可靠帧传输；不解释命令、事件或会话语义。 */
export interface RemoteLink {
  state(): RemoteLinkState;
  send(frame: RemoteFrame): void;
  close(reason?: string): void;
  onFrame(listener: (frame: RemoteFrame) => void): Unsubscribe;
  onState(listener: (state: RemoteLinkState) => void): Unsubscribe;
}
