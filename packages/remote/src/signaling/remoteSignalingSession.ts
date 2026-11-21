import {
  REMOTE_PROTOCOL_VERSION,
  type RemoteError,
  type RemoteIceCandidate,
  type RemoteRole,
  type SignalingFrame,
  type SignalingJoined,
  type SignalingJoinRejected,
  type SignalingPeer,
} from "@answra/shared/schema";
import type { SignalingChannel, SignalingChannelState } from "../ports/signalingChannel";
import type { Unsubscribe } from "../ports/subscription";
import { RemoteOperationError, remoteError, toRemoteError } from "../protocol/errors";
import {
  REMOTE_SIGNALING_JOIN_TIMEOUT_MS,
  type RemoteSignalingJoined,
  type RemoteSignalingSessionOptions,
  type RemoteSignalingState,
  type RemoteSignalingTimers,
} from "./contracts";
import { RemoteSignalingNegotiation } from "./negotiation";

interface PeerWaiter {
  resolve: (peer: SignalingPeer) => void;
  reject: (error: RemoteOperationError) => void;
}

/**
 * 房间信令状态机：确认加入、追踪单个对端并约束 offer/answer/ICE 方向。
 * 不创建 WebRTC，也不生成 SDP；传输适配负责把 SDP/ICE 应用到 RTCPeerConnection。
 *
 * 规模例外：事件订阅 fanout 与状态迁移目前内聚在一个类中；R6 接入真实 transport
 * 并出现第二个消费者前不抽独立事件总线，避免把一次状态迁移拆成跨文件跳转。
 */
export class RemoteSignalingSession {
  private readonly channel: SignalingChannel;
  private readonly roomId: string;
  private readonly peerId: string;
  private readonly role: RemoteRole;
  private readonly timers: RemoteSignalingTimers;
  private readonly joinTimeoutMs: number;
  private readonly negotiation: RemoteSignalingNegotiation;
  private readonly unsubscribers: Unsubscribe[] = [];
  private readonly peerJoinedListeners = new Set<(peer: SignalingPeer) => void>();
  private readonly peerLeftListeners = new Set<(peer: SignalingPeer) => void>();
  private readonly offerListeners = new Set<(sdp: string) => void>();
  private readonly answerListeners = new Set<(sdp: string) => void>();
  private readonly iceCandidateListeners = new Set<(candidate: RemoteIceCandidate) => void>();
  private readonly stateListeners = new Set<(state: RemoteSignalingState) => void>();
  private readonly errorListeners = new Set<(error: RemoteOperationError) => void>();
  private readonly peerWaiters = new Set<PeerWaiter>();
  private currentState: RemoteSignalingState = "idle";
  private joinedInfo?: RemoteSignalingJoined;
  private currentPeer?: SignalingPeer;
  private currentConnectionId?: string;
  private connectionSequence = 0;
  private joinPromise?: Promise<RemoteSignalingJoined>;
  private joinResolve?: (joined: RemoteSignalingJoined) => void;
  private joinReject?: (error: RemoteOperationError) => void;
  private cancelJoinTimer?: () => void;
  private closed = false;

  constructor({
    channel,
    roomId,
    peerId,
    role,
    timers,
    joinTimeoutMs = REMOTE_SIGNALING_JOIN_TIMEOUT_MS,
  }: RemoteSignalingSessionOptions) {
    this.channel = channel;
    this.roomId = roomId;
    this.peerId = peerId;
    this.role = role;
    this.timers = timers;
    this.joinTimeoutMs = joinTimeoutMs;
    this.negotiation = new RemoteSignalingNegotiation(role, peerId);

    this.unsubscribers.push(
      this.channel.onFrame((frame) => {
        this.handleFrame(frame);
      }),
    );
    this.unsubscribers.push(
      this.channel.onState((state) => {
        this.handleChannelState(state);
      }),
    );
  }

  state(): RemoteSignalingState {
    return this.currentState;
  }

  joined(): RemoteSignalingJoined | undefined {
    return this.joinedInfo;
  }

  peer(): SignalingPeer | undefined {
    return this.currentPeer;
  }

  connectionId(): string | undefined {
    return this.currentConnectionId;
  }

  join(): Promise<RemoteSignalingJoined> {
    if (this.closed) {
      return Promise.reject(
        new RemoteOperationError(remoteError("remote-disconnected", "signaling session is closed")),
      );
    }
    if (this.joinPromise !== undefined) return this.joinPromise;

    this.setState("joining");
    const promise = new Promise<RemoteSignalingJoined>((resolve, reject) => {
      this.joinResolve = resolve;
      this.joinReject = reject;
    });
    this.joinPromise = promise;
    this.startJoinTimer();

    if (this.channel.state() === "open") {
      this.sendJoin();
    } else if (this.channel.state() === "closed") {
      this.finishClose(remoteError("remote-disconnected", "signaling channel is closed"));
    }
    return promise;
  }

  waitForPeer(): Promise<SignalingPeer> {
    if (this.closed) {
      return Promise.reject(
        new RemoteOperationError(remoteError("remote-disconnected", "signaling session is closed")),
      );
    }
    if (this.joinedInfo === undefined) {
      return Promise.reject(
        new RemoteOperationError(remoteError("invalid-command", "join the room first")),
      );
    }
    if (this.currentPeer !== undefined) return Promise.resolve(this.currentPeer);

    return new Promise<SignalingPeer>((resolve, reject) => {
      this.peerWaiters.add({ resolve, reject });
    });
  }

  sendOffer(sdp: string): void {
    this.requirePeer();
    const connectionId = this.currentConnectionId;
    if (connectionId === undefined) {
      throw new RemoteOperationError(
        remoteError("invalid-command", "connection id is not assigned"),
      );
    }
    this.sendFrame(this.negotiation.offer(sdp, connectionId));
  }

  sendAnswer(sdp: string): void {
    this.requirePeer();
    this.sendFrame(this.negotiation.answer(sdp));
  }

  sendIceCandidate(candidate: RemoteIceCandidate): void {
    this.requirePeer();
    this.sendFrame(this.negotiation.iceCandidate(candidate));
  }

  close(): void {
    if (this.closed) return;
    this.finishClose(remoteError("remote-disconnected", "signaling session closed"));
    this.channel.close("signaling-session-closed");
  }

  onPeerJoined(listener: (peer: SignalingPeer) => void): Unsubscribe {
    this.peerJoinedListeners.add(listener);
    return () => this.peerJoinedListeners.delete(listener);
  }

  onPeerLeft(listener: (peer: SignalingPeer) => void): Unsubscribe {
    this.peerLeftListeners.add(listener);
    return () => this.peerLeftListeners.delete(listener);
  }

  onOffer(listener: (sdp: string) => void): Unsubscribe {
    this.offerListeners.add(listener);
    return () => this.offerListeners.delete(listener);
  }

  onAnswer(listener: (sdp: string) => void): Unsubscribe {
    this.answerListeners.add(listener);
    return () => this.answerListeners.delete(listener);
  }

  onIceCandidate(listener: (candidate: RemoteIceCandidate) => void): Unsubscribe {
    this.iceCandidateListeners.add(listener);
    return () => this.iceCandidateListeners.delete(listener);
  }

  onState(listener: (state: RemoteSignalingState) => void): Unsubscribe {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onError(listener: (error: RemoteOperationError) => void): Unsubscribe {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  private handleFrame(frame: SignalingFrame): void {
    if (this.closed) return;
    switch (frame.type) {
      case "joined":
        this.acceptJoined(frame);
        return;
      case "join-rejected":
        this.acceptJoinRejected(frame);
        return;
      case "peer-joined":
        this.acceptPeerJoined(frame);
        return;
      case "peer-left":
        this.acceptPeerLeft(frame.peerId);
        return;
      case "offer":
        this.acceptOffer(frame);
        return;
      case "answer":
        this.acceptAnswer(frame);
        return;
      case "ice-candidate":
        this.acceptIceCandidate(frame);
        return;
      case "error":
        this.fail(frame.error);
        return;
      default:
        return;
    }
  }

  private handleChannelState(state: SignalingChannelState): void {
    if (this.closed) return;
    if (state === "open") {
      if (this.currentState === "joining") this.sendJoin();
      return;
    }
    if (state === "closed") {
      this.finishClose(remoteError("remote-disconnected", "signaling channel closed"));
    }
  }

  private sendJoin(): void {
    if (this.closed || this.joinedInfo !== undefined) return;
    this.sendFrame({
      type: "join",
      roomId: this.roomId,
      peerId: this.peerId,
      role: this.role,
      protocolVersion: REMOTE_PROTOCOL_VERSION,
    });
  }

  private acceptJoined(joined: SignalingJoined): void {
    if (this.currentState !== "joining") {
      this.fail(remoteError("invalid-frame", "unexpected joined frame"));
      return;
    }
    if (
      joined.roomId !== this.roomId ||
      joined.peerId !== this.peerId ||
      joined.role !== this.role
    ) {
      this.fail(remoteError("invalid-frame", "joined acknowledgement does not match the join"));
      return;
    }
    if (joined.peers.length > 1 || joined.peers.some((peer) => peer.role === this.role)) {
      this.fail(remoteError("room-conflict", "room already has a peer with the same role"));
      return;
    }
    if (joined.peers.some((peer) => peer.peerId === this.peerId)) {
      this.fail(remoteError("invalid-frame", "joined acknowledgement includes this peer"));
      return;
    }

    this.cancelTimer();
    this.joinedInfo = {
      roomId: joined.roomId,
      peerId: joined.peerId,
      role: joined.role,
      peers: joined.peers,
    };
    this.joinResolve?.(this.joinedInfo);
    this.joinResolve = undefined;
    this.joinReject = undefined;

    const peer = joined.peers[0];
    if (peer === undefined) {
      this.setState("waiting");
      return;
    }
    this.acceptPeer(peer);
  }

  private acceptJoinRejected(rejected: SignalingJoinRejected): void {
    this.fail(rejected.error);
  }

  private acceptPeerJoined(frame: Extract<SignalingFrame, { type: "peer-joined" }>): void {
    if (this.joinedInfo === undefined) {
      this.fail(remoteError("invalid-frame", "peer joined before the room acknowledgement"));
      return;
    }
    if (frame.peerId === this.peerId) {
      this.fail(remoteError("invalid-frame", "peer-joined refers to this peer"));
      return;
    }
    if (this.currentPeer !== undefined) {
      this.fail(remoteError("room-conflict", "room already has a peer"));
      return;
    }
    if (frame.role === this.role) {
      this.fail(remoteError("room-conflict", "peer has the same role"));
      return;
    }
    this.acceptPeer({ peerId: frame.peerId, role: frame.role });
  }

  private acceptPeerLeft(peerId: string): void {
    const peer = this.currentPeer;
    if (peer?.peerId !== peerId) return;
    this.currentPeer = undefined;
    this.currentConnectionId = undefined;
    this.negotiation.reset();
    this.setState("waiting");
    for (const listener of this.peerLeftListeners) listener(peer);
  }

  private acceptOffer(frame: Extract<SignalingFrame, { type: "offer" }>): void {
    if (this.currentPeer?.peerId !== frame.fromPeerId) {
      this.fail(remoteError("invalid-frame", "unexpected remote offer"));
      return;
    }
    if (this.role === "controller") {
      if (
        this.currentConnectionId !== undefined &&
        this.currentConnectionId !== frame.connectionId
      ) {
        return;
      }
      if (this.negotiation.connectionId() === frame.connectionId) return;
      this.currentConnectionId = frame.connectionId;
    }
    try {
      const sdp = this.negotiation.acceptOffer(frame);
      for (const listener of this.offerListeners) listener(sdp);
    } catch (error) {
      this.failFrom(error);
    }
  }

  private acceptAnswer(frame: Extract<SignalingFrame, { type: "answer" }>): void {
    if (this.currentPeer?.peerId !== frame.fromPeerId) {
      this.fail(remoteError("invalid-frame", "unexpected remote answer"));
      return;
    }
    if (this.currentConnectionId !== frame.connectionId) {
      return;
    }
    try {
      const sdp = this.negotiation.acceptAnswer(frame);
      for (const listener of this.answerListeners) listener(sdp);
    } catch (error) {
      this.failFrom(error);
    }
  }

  private acceptIceCandidate(frame: Extract<SignalingFrame, { type: "ice-candidate" }>): void {
    if (this.currentPeer?.peerId !== frame.fromPeerId) {
      this.fail(remoteError("invalid-frame", "ice candidate from an unknown peer"));
      return;
    }
    if (this.currentConnectionId !== frame.connectionId) {
      return;
    }
    try {
      const candidate = this.negotiation.acceptIceCandidate(frame);
      for (const listener of this.iceCandidateListeners) listener(candidate);
    } catch (error) {
      this.failFrom(error);
    }
  }

  private acceptPeer(peer: SignalingPeer): void {
    this.currentPeer = peer;
    this.negotiation.reset();
    this.currentConnectionId =
      this.role === "host"
        ? `${this.peerId}:${peer.peerId}:${++this.connectionSequence}`
        : undefined;
    this.setState("ready");
    for (const listener of this.peerJoinedListeners) listener(peer);
    for (const waiter of this.peerWaiters) waiter.resolve(peer);
    this.peerWaiters.clear();
  }

  private requirePeer(): SignalingPeer {
    if (this.closed) {
      throw new RemoteOperationError(
        remoteError("remote-disconnected", "signaling session is closed"),
      );
    }
    if (this.joinedInfo === undefined) {
      throw new RemoteOperationError(remoteError("invalid-command", "join the room first"));
    }
    if (this.currentPeer === undefined) {
      throw new RemoteOperationError(remoteError("invalid-command", "peer has not joined"));
    }
    return this.currentPeer;
  }

  private sendFrame(frame: SignalingFrame): void {
    try {
      this.channel.send(frame);
    } catch {
      this.fail(remoteError("transport-closed", "signaling channel is not writable"));
      throw new RemoteOperationError(
        remoteError("transport-closed", "signaling channel is not writable"),
      );
    }
  }

  private startJoinTimer(): void {
    let cancel: (() => void) | undefined;
    cancel = this.timers.after(this.joinTimeoutMs, () => {
      cancel?.();
      this.cancelJoinTimer = undefined;
      this.fail(remoteError("timeout", "timed out joining the remote room"));
    });
    this.cancelJoinTimer = cancel;
    if (this.closed) this.cancelTimer();
  }

  private cancelTimer(): void {
    this.cancelJoinTimer?.();
    this.cancelJoinTimer = undefined;
  }

  private setState(state: RemoteSignalingState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    for (const listener of this.stateListeners) listener(state);
  }

  private failFrom(error: unknown): void {
    this.fail(toRemoteError(error));
  }

  private fail(error: RemoteError): void {
    if (this.closed) return;
    const operationError = new RemoteOperationError(error);
    for (const listener of this.errorListeners) listener(operationError);
    this.finishClose(error);
    this.channel.close("signaling-failed");
  }

  private finishClose(error: RemoteError): void {
    if (this.closed) return;
    this.closed = true;
    this.setState("closed");
    this.cancelTimer();
    const operationError = new RemoteOperationError(error);
    this.joinReject?.(operationError);
    this.joinReject = undefined;
    this.joinResolve = undefined;
    for (const waiter of this.peerWaiters) waiter.reject(operationError);
    this.peerWaiters.clear();
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
  }
}
