import {
  decodeRemoteFrame,
  encodeRemoteFrame,
  type RemoteLink,
  type RemoteLinkState,
  type Unsubscribe,
} from "@answra/remote";
import {
  REMOTE_DATA_CHANNEL_LABEL,
  REMOTE_DATA_CHANNEL_PROTOCOL,
  type RemoteFrame,
  type RemoteRole,
} from "@answra/shared/schema";
import nodeDataChannel, {
  type DataChannel,
  type PeerConnection,
  type RtcConfig,
} from "node-datachannel";
import type { RemoteSignalingFacade } from "./remoteLinkFactory";

const DEFAULT_MID = "0";
const DEFAULT_PEER_NAME = "answra-remote";

export interface NodeWebRtcLinkOptions {
  role: RemoteRole;
  signaling: RemoteSignalingFacade;
  iceServers?: readonly string[];
  peerName?: string;
  createPeerConnection?: (peerName: string, config: RtcConfig) => PeerConnection;
}

/**
 * CLI 的 WebRTC DataChannel 传输。只负责一条连接：应用 offer/answer 与 ICE、
 * 收发 RemoteFrame。构造前信令必须已经 ready；host 构造时创建 DataChannel 并
 * 自动触发 offer。node-datachannel 在 createDataChannel/setRemoteDescription
 * 时自动推进协商，此处不重复调用 setLocalDescription；重连和连接重建在组合层处理。
 */
export class NodeWebRtcLink implements RemoteLink {
  private readonly signaling: RemoteSignalingFacade;
  private readonly peer: PeerConnection;
  private readonly frameListeners = new Set<(frame: RemoteFrame) => void>();
  private readonly stateListeners = new Set<(state: RemoteLinkState) => void>();
  private channel?: DataChannel;
  private currentState: RemoteLinkState = "connecting";
  private closed = false;

  constructor({
    role,
    signaling,
    iceServers = [],
    peerName = DEFAULT_PEER_NAME,
    createPeerConnection = (name, config) => new nodeDataChannel.PeerConnection(name, config),
  }: NodeWebRtcLinkOptions) {
    this.signaling = signaling;
    this.peer = createPeerConnection(peerName, { iceServers: [...iceServers] });

    this.peer.onLocalDescription((sdp, type) => {
      try {
        if (type === "offer") this.signaling.sendOffer(sdp);
        else if (type === "answer") this.signaling.sendAnswer(sdp);
      } catch {
        this.close("signaling-closed");
      }
    });
    this.peer.onLocalCandidate((candidate, mid) => {
      try {
        this.signaling.sendIceCandidate({
          candidate,
          ...(mid.length === 0 ? {} : { sdpMid: mid }),
        });
      } catch {
        this.close("signaling-closed");
      }
    });
    this.peer.onStateChange((state) => {
      if (state === "failed" || state === "closed") this.close(`peer-${state}`);
    });

    this.signaling.onOffer((sdp) => {
      try {
        this.peer.setRemoteDescription(sdp, "offer");
      } catch {
        this.close("invalid-offer");
      }
    });
    this.signaling.onAnswer((sdp) => {
      try {
        this.peer.setRemoteDescription(sdp, "answer");
      } catch {
        this.close("invalid-answer");
      }
    });
    this.signaling.onIceCandidate((candidate) => {
      try {
        this.peer.addRemoteCandidate(candidate.candidate, candidate.sdpMid ?? DEFAULT_MID);
      } catch {
        this.close("invalid-ice");
      }
    });

    if (role === "host") {
      this.attachChannel(
        this.peer.createDataChannel(REMOTE_DATA_CHANNEL_LABEL, {
          protocol: REMOTE_DATA_CHANNEL_PROTOCOL,
        }),
      );
    } else {
      this.peer.onDataChannel((channel) => this.attachChannel(channel));
    }
  }

  state(): RemoteLinkState {
    return this.currentState;
  }

  send(frame: RemoteFrame): void {
    if (this.currentState !== "open" || this.channel?.isOpen() !== true) {
      throw new Error("remote webrtc link is not open");
    }
    const sent = this.channel.sendMessage(encodeRemoteFrame(frame));
    if (!sent) {
      this.close("send-failed");
      throw new Error("remote webrtc send failed");
    }
  }

  close(_reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.channel?.close();
    } catch {
      // 通道可能已被远端关闭；继续关闭 PeerConnection。
    }
    try {
      this.peer.close();
    } catch {
      // PeerConnection 可能已由底层关闭。
    }
    this.setState("closed");
  }

  onFrame(listener: (frame: RemoteFrame) => void): Unsubscribe {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onState(listener: (state: RemoteLinkState) => void): Unsubscribe {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private attachChannel(channel: DataChannel): void {
    if (this.closed) {
      channel.close();
      return;
    }
    this.channel = channel;
    channel.onOpen(() => this.setState("open"));
    channel.onClosed(() => this.close("channel-closed"));
    channel.onError(() => this.close("channel-error"));
    channel.onMessage((message) => this.receive(message));
  }

  private receive(message: string | Buffer | ArrayBuffer): void {
    if (this.closed) return;
    let frame: RemoteFrame;
    try {
      frame = decodeRemoteFrame(toText(message));
    } catch {
      this.close("invalid-frame");
      return;
    }
    for (const listener of this.frameListeners) listener(frame);
  }

  private setState(state: RemoteLinkState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    for (const listener of this.stateListeners) listener(state);
  }
}

function toText(message: string | Buffer | ArrayBuffer): string {
  if (typeof message === "string") return message;
  if (message instanceof ArrayBuffer) return new TextDecoder().decode(message);
  return message.toString("utf8");
}
