import type { RemoteFrame } from "@answra/shared/schema";
import type { RemoteLink, RemoteLinkState } from "../ports/remoteLink";
import type { Unsubscribe } from "../ports/subscription";

class FakeRemoteLink implements RemoteLink {
  private currentState: RemoteLinkState = "open";
  private readonly frameListeners = new Set<(frame: RemoteFrame) => void>();
  private readonly stateListeners = new Set<(state: RemoteLinkState) => void>();

  constructor(private readonly peer: () => FakeRemoteLink | undefined) {}

  state(): RemoteLinkState {
    return this.currentState;
  }

  send(frame: RemoteFrame): void {
    if (this.currentState !== "open") throw new Error("remote-link-closed");
    const peer = this.peer();
    if (peer === undefined) return;
    void Promise.resolve().then(() => peer.receive(frame));
  }

  close(): void {
    if (this.currentState === "closed") return;
    this.currentState = "closed";
    for (const listener of this.stateListeners) listener(this.currentState);
  }

  onFrame(listener: (frame: RemoteFrame) => void): Unsubscribe {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onState(listener: (state: RemoteLinkState) => void): Unsubscribe {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private receive(frame: RemoteFrame): void {
    if (this.currentState !== "open") return;
    for (const listener of this.frameListeners) listener(frame);
  }
}

export interface FakeRemoteLinkPair {
  host: RemoteLink;
  controller: RemoteLink;
  disconnect(): void;
}

export function createFakeRemoteLinkPair(): FakeRemoteLinkPair {
  let host: FakeRemoteLink | undefined;
  let controller: FakeRemoteLink | undefined;
  host = new FakeRemoteLink(() => controller);
  controller = new FakeRemoteLink(() => host);
  return {
    host,
    controller,
    disconnect() {
      host?.close();
      controller?.close();
    },
  };
}

/** 让 fake link 排队的微任务执行完；测试用于确定性等待。 */
export async function flushFakeRemoteLink(): Promise<void> {
  await Promise.resolve();
}
