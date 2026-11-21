import type { SignalingChannel, SignalingChannelState, Unsubscribe } from "@answra/remote";
import { type SignalingFrame, signalingFrameSchema } from "@answra/shared/schema";

/** Node 全局 WebSocket 的最小适配面；测试注入 fake socket，生产注入全局 WebSocket。 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
}

export interface WebSocketSignalingChannelOptions {
  url: string;
  protocols: readonly string[];
  createSocket: (url: string, protocols: readonly string[]) => WebSocketLike;
}

const WEB_SOCKET_OPEN = 1;

/**
 * 官方信令 WebSocket 适配：只做帧编解码和连接状态，不重连、不换 ticket。
 * 重连策略在 `RemoteSignalingSession` 之外的组合层处理。
 */
export class WebSocketSignalingChannel implements SignalingChannel {
  private readonly socket: WebSocketLike;
  private currentState: SignalingChannelState = "connecting";
  private readonly frameListeners = new Set<(frame: SignalingFrame) => void>();
  private readonly stateListeners = new Set<(state: SignalingChannelState) => void>();

  constructor({ url, protocols, createSocket }: WebSocketSignalingChannelOptions) {
    const socket = createSocket(url, protocols);
    this.socket = socket;

    socket.addEventListener("open", () => this.setState("open"));
    socket.addEventListener("message", (event) => this.receive((event as { data: unknown }).data));
    socket.addEventListener("close", () => this.setState("closed"));
    socket.addEventListener("error", () => {
      this.setState("closed");
      this.safeClose();
    });
  }

  state(): SignalingChannelState {
    return this.currentState;
  }

  send(frame: SignalingFrame): void {
    if (this.currentState !== "open" || this.socket.readyState !== WEB_SOCKET_OPEN) {
      throw new Error("signaling websocket is not open");
    }
    this.socket.send(JSON.stringify(signalingFrameSchema.parse(frame)));
  }

  close(reason?: string): void {
    if (this.currentState === "closed") return;
    this.setState("closed");
    try {
      this.socket.close(1000, reason?.slice(0, 123));
    } catch {
      // 连接尚未完成时 close 可能抛错；状态已经关闭，不再向上传播。
    }
  }

  onFrame(listener: (frame: SignalingFrame) => void): Unsubscribe {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onState(listener: (state: SignalingChannelState) => void): Unsubscribe {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private receive(data: unknown): void {
    if (this.currentState !== "open") return;
    let frame: SignalingFrame;
    try {
      frame = signalingFrameSchema.parse(JSON.parse(toStringData(data)));
    } catch {
      this.close("invalid-frame");
      return;
    }
    for (const listener of this.frameListeners) listener(frame);
  }

  private setState(state: SignalingChannelState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    for (const listener of this.stateListeners) listener(state);
  }

  private safeClose(): void {
    try {
      this.socket.close();
    } catch {
      // 状态已经是 closed；关闭失败没有额外可恢复动作。
    }
  }
}

function toStringData(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  throw new Error("unsupported signaling websocket message");
}
