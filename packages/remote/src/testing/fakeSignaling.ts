import {
  REMOTE_PROTOCOL_VERSION,
  type RemoteErrorCode,
  type RemoteRole,
  type SignalingFrame,
} from "@answra/shared/schema";
import type { SignalingChannel, SignalingChannelState } from "../ports/signalingChannel";
import type { Unsubscribe } from "../ports/subscription";
import { remoteError } from "../protocol/errors";

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

interface RoomPeer {
  channel: FakeServerChannel;
  roomId: string;
  peerId: string;
  role: RemoteRole;
}

class FakeServerChannel implements SignalingChannel {
  private currentState: SignalingChannelState = "open";
  private readonly frameListeners = new Set<(frame: SignalingFrame) => void>();
  private readonly stateListeners = new Set<(state: SignalingChannelState) => void>();

  constructor(private readonly server: InMemorySignalingServer) {}

  state(): SignalingChannelState {
    return this.currentState;
  }

  send(frame: SignalingFrame): void {
    if (this.currentState !== "open") throw new Error("signaling-channel-closed");
    void Promise.resolve().then(() => this.server.receive(this, frame));
  }

  close(): void {
    this.server.disconnect(this);
  }

  onFrame(listener: (frame: SignalingFrame) => void): Unsubscribe {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onState(listener: (state: SignalingChannelState) => void): Unsubscribe {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  deliver(frame: SignalingFrame): void {
    if (this.currentState !== "open") return;
    for (const listener of this.frameListeners) listener(frame);
  }

  disconnectFromServer(): void {
    if (this.currentState === "closed") return;
    this.currentState = "closed";
    for (const listener of this.stateListeners) listener(this.currentState);
  }
}

export interface FakeSignalingServer {
  connect(): SignalingChannel;
  disconnectAll(): void;
}

class InMemorySignalingServer implements FakeSignalingServer {
  private readonly rooms = new Map<string, Map<FakeServerChannel, RoomPeer>>();
  private readonly peers = new Map<FakeServerChannel, RoomPeer>();
  private readonly channels = new Set<FakeServerChannel>();

  connect(): SignalingChannel {
    const channel = new FakeServerChannel(this);
    this.channels.add(channel);
    return channel;
  }

  receive(channel: FakeServerChannel, frame: SignalingFrame): void {
    if (channel.state() !== "open") return;
    if (frame.type === "join") {
      this.join(channel, frame);
      return;
    }

    const sender = this.peers.get(channel);
    if (sender === undefined) return;

    if (frame.type === "offer" || frame.type === "answer" || frame.type === "ice-candidate") {
      const target = this.otherPeer(sender);
      if (target === undefined) return;
      target.channel.deliver({ ...frame, fromPeerId: sender.peerId });
    }
  }

  disconnect(channel: FakeServerChannel): void {
    const peer = this.peers.get(channel);
    channel.disconnectFromServer();
    this.channels.delete(channel);
    if (peer === undefined) return;

    this.peers.delete(channel);
    const room = this.rooms.get(peer.roomId);
    room?.delete(channel);
    if (room !== undefined && room.size === 0) this.rooms.delete(peer.roomId);

    if (room === undefined) return;
    for (const remaining of room.values()) {
      remaining.channel.deliver({ type: "peer-left", peerId: peer.peerId });
    }
  }

  disconnectAll(): void {
    for (const channel of [...this.channels]) {
      this.disconnect(channel);
    }
  }

  private join(channel: FakeServerChannel, frame: Extract<SignalingFrame, { type: "join" }>): void {
    if (this.peers.has(channel)) {
      this.reject(channel, "invalid-frame", "peer already joined");
      return;
    }
    if (frame.protocolVersion !== REMOTE_PROTOCOL_VERSION) {
      this.reject(channel, "unsupported-version", "unsupported signaling protocol version");
      return;
    }

    const room = this.rooms.get(frame.roomId) ?? new Map<FakeServerChannel, RoomPeer>();
    const existing = [...room.values()];
    if (existing.some((peer) => peer.role === frame.role)) {
      this.reject(
        channel,
        frame.role === "controller" ? "controller-busy" : "room-conflict",
        frame.role === "controller" ? "room already has a controller" : "room already has a host",
      );
      return;
    }

    const peer: RoomPeer = {
      channel,
      roomId: frame.roomId,
      peerId: frame.peerId,
      role: frame.role,
    };
    room.set(channel, peer);
    this.rooms.set(frame.roomId, room);
    this.peers.set(channel, peer);

    channel.deliver({
      type: "joined",
      roomId: frame.roomId,
      peerId: frame.peerId,
      role: frame.role,
      peers: existing.map(({ peerId, role }) => ({ peerId, role })),
    });
    for (const existingPeer of existing) {
      existingPeer.channel.deliver({
        type: "peer-joined",
        peerId: frame.peerId,
        role: frame.role,
      });
    }
  }

  private reject(channel: FakeServerChannel, code: RemoteErrorCode, message: string): void {
    channel.deliver({
      type: "join-rejected",
      error: remoteError(code, message),
    });
  }

  private otherPeer(sender: RoomPeer): RoomPeer | undefined {
    const room = this.rooms.get(sender.roomId);
    if (room === undefined) return undefined;
    for (const peer of room.values()) {
      if (peer !== sender) return peer;
    }
    return undefined;
  }
}

export function createFakeSignalingServer(): FakeSignalingServer {
  return new InMemorySignalingServer();
}

/** 排空 fake signaling 的微任务链；测试用于确定性等待。 */
export async function flushFakeSignaling(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}
