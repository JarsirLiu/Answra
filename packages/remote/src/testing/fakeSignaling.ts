import type { SignalingFrame } from "@answra/shared/schema";
import type { SignalingChannel, SignalingChannelState } from "../ports/signalingChannel";
import type { Unsubscribe } from "../ports/subscription";

class FakeSignalingChannel implements SignalingChannel {
  private currentState: SignalingChannelState = "open";
  private readonly frameListeners = new Set<(frame: SignalingFrame) => void>();
  private readonly stateListeners = new Set<(state: SignalingChannelState) => void>();

  constructor(private readonly peer: () => FakeSignalingChannel | undefined) {}

  state(): SignalingChannelState {
    return this.currentState;
  }

  send(frame: SignalingFrame): void {
    if (this.currentState !== "open") throw new Error("signaling-channel-closed");
    const peer = this.peer();
    if (peer === undefined) return;
    void Promise.resolve().then(() => peer.receive(frame));
  }

  close(): void {
    if (this.currentState === "closed") return;
    this.currentState = "closed";
    for (const listener of this.stateListeners) listener(this.currentState);
  }

  onFrame(listener: (frame: SignalingFrame) => void): Unsubscribe {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onState(listener: (state: SignalingChannelState) => void): Unsubscribe {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private receive(frame: SignalingFrame): void {
    if (this.currentState !== "open") return;
    for (const listener of this.frameListeners) listener(frame);
  }
}

export interface FakeSignalingPair {
  host: SignalingChannel;
  controller: SignalingChannel;
  disconnect(): void;
}

export function createFakeSignalingPair(): FakeSignalingPair {
  let host: FakeSignalingChannel | undefined;
  let controller: FakeSignalingChannel | undefined;
  host = new FakeSignalingChannel(() => controller);
  controller = new FakeSignalingChannel(() => host);
  return {
    host,
    controller,
    disconnect() {
      host?.close();
      controller?.close();
    },
  };
}

/** 让 fake signaling 排队的微任务执行完；测试用于确定性等待。 */
export async function flushFakeSignaling(): Promise<void> {
  await Promise.resolve();
}
