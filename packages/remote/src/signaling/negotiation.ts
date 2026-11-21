import type { RemoteIceCandidate, RemoteRole, SignalingFrame } from "@answra/shared/schema";
import { RemoteOperationError, remoteError } from "../protocol/errors";

/**
 * SDP/ICE 方向与连接代际状态：host 只发 offer，controller 只发 answer，且 ICE 必须晚于本地描述。
 * 不生成 SDP，也不处理 RTCPeerConnection；属于旧 connectionId 的迟到帧由会话层丢弃或在此拒绝。
 */
export class RemoteSignalingNegotiation {
  private offerSent = false;
  private answerSent = false;
  private remoteOfferReceived = false;
  private remoteAnswerReceived = false;
  private localConnectionId?: string;
  private remoteConnectionId?: string;

  constructor(
    private readonly role: RemoteRole,
    private readonly peerId: string,
  ) {}

  reset(): void {
    this.offerSent = false;
    this.answerSent = false;
    this.remoteOfferReceived = false;
    this.remoteAnswerReceived = false;
    this.localConnectionId = undefined;
    this.remoteConnectionId = undefined;
  }

  connectionId(): string | undefined {
    return this.localConnectionId ?? this.remoteConnectionId;
  }

  offer(sdp: string, connectionId: string): Extract<SignalingFrame, { type: "offer" }> {
    if (this.role !== "host") {
      throw new RemoteOperationError(remoteError("invalid-command", "only the host sends offers"));
    }
    if (this.offerSent) {
      throw new RemoteOperationError(remoteError("invalid-command", "offer already sent"));
    }
    this.offerSent = true;
    this.localConnectionId = connectionId;
    return { type: "offer", fromPeerId: this.peerId, connectionId, sdp };
  }

  answer(sdp: string): Extract<SignalingFrame, { type: "answer" }> {
    if (this.role !== "controller") {
      throw new RemoteOperationError(
        remoteError("invalid-command", "only the controller sends answers"),
      );
    }
    if (!this.remoteOfferReceived) {
      throw new RemoteOperationError(remoteError("invalid-command", "offer not received"));
    }
    if (this.answerSent) {
      throw new RemoteOperationError(remoteError("invalid-command", "answer already sent"));
    }
    const connectionId = this.remoteConnectionId;
    if (connectionId === undefined) {
      throw new RemoteOperationError(
        remoteError("invalid-frame", "remote offer is missing its connection id"),
      );
    }
    this.answerSent = true;
    this.localConnectionId = connectionId;
    return { type: "answer", fromPeerId: this.peerId, connectionId, sdp };
  }

  iceCandidate(candidate: RemoteIceCandidate): Extract<SignalingFrame, { type: "ice-candidate" }> {
    if (this.role === "host" && !this.offerSent) {
      throw new RemoteOperationError(
        remoteError("invalid-command", "send the offer before host candidates"),
      );
    }
    if (this.role === "controller" && !this.answerSent) {
      throw new RemoteOperationError(
        remoteError("invalid-command", "send the answer before controller candidates"),
      );
    }
    const connectionId = this.localConnectionId;
    if (connectionId === undefined) {
      throw new RemoteOperationError(
        remoteError("invalid-command", "send the local description before candidates"),
      );
    }
    return { type: "ice-candidate", fromPeerId: this.peerId, connectionId, candidate };
  }

  acceptOffer(frame: Extract<SignalingFrame, { type: "offer" }>): string {
    if (this.role !== "controller") {
      throw new RemoteOperationError(remoteError("invalid-frame", "unexpected remote offer"));
    }
    if (this.remoteOfferReceived) {
      throw new RemoteOperationError(remoteError("invalid-frame", "remote offer already received"));
    }
    this.remoteOfferReceived = true;
    this.remoteConnectionId = frame.connectionId;
    return frame.sdp;
  }

  acceptAnswer(frame: Extract<SignalingFrame, { type: "answer" }>): string {
    if (this.role !== "host") {
      throw new RemoteOperationError(remoteError("invalid-frame", "unexpected remote answer"));
    }
    if (!this.offerSent || this.remoteAnswerReceived) {
      throw new RemoteOperationError(remoteError("invalid-frame", "unexpected remote answer"));
    }
    if (frame.connectionId !== this.localConnectionId) {
      throw new RemoteOperationError(
        remoteError("invalid-frame", "remote answer belongs to another connection"),
      );
    }
    this.remoteAnswerReceived = true;
    return frame.sdp;
  }

  acceptIceCandidate(
    frame: Extract<SignalingFrame, { type: "ice-candidate" }>,
  ): RemoteIceCandidate {
    const remoteDescriptionReceived =
      this.role === "controller" ? this.remoteOfferReceived : this.remoteAnswerReceived;
    if (!remoteDescriptionReceived) {
      throw new RemoteOperationError(
        remoteError("invalid-frame", "ice candidate arrived before remote SDP"),
      );
    }
    const expectedConnectionId =
      this.role === "controller" ? this.remoteConnectionId : this.localConnectionId;
    if (frame.connectionId !== expectedConnectionId) {
      throw new RemoteOperationError(
        remoteError("invalid-frame", "ice candidate belongs to another connection"),
      );
    }
    return frame.candidate;
  }
}
