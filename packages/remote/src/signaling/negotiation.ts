import type { RemoteIceCandidate, RemoteRole, SignalingFrame } from "@answra/shared/schema";
import { RemoteOperationError, remoteError } from "../protocol/errors";

/**
 * SDP/ICE 方向状态：host 只发 offer，controller 只发 answer，且 ICE 必须晚于本地描述。
 * 不生成 SDP，也不处理 RTCPeerConnection；只拒绝不符合单向首连的帧。
 */
export class RemoteSignalingNegotiation {
  private offerSent = false;
  private answerSent = false;
  private remoteOfferReceived = false;
  private remoteAnswerReceived = false;

  constructor(
    private readonly role: RemoteRole,
    private readonly peerId: string,
  ) {}

  reset(): void {
    this.offerSent = false;
    this.answerSent = false;
    this.remoteOfferReceived = false;
    this.remoteAnswerReceived = false;
  }

  offer(sdp: string): Extract<SignalingFrame, { type: "offer" }> {
    if (this.role !== "host") {
      throw new RemoteOperationError(remoteError("invalid-command", "only the host sends offers"));
    }
    if (this.offerSent) {
      throw new RemoteOperationError(remoteError("invalid-command", "offer already sent"));
    }
    this.offerSent = true;
    return { type: "offer", fromPeerId: this.peerId, sdp };
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
    this.answerSent = true;
    return { type: "answer", fromPeerId: this.peerId, sdp };
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
    return { type: "ice-candidate", fromPeerId: this.peerId, candidate };
  }

  acceptOffer(frame: Extract<SignalingFrame, { type: "offer" }>): string {
    if (this.role !== "controller") {
      throw new RemoteOperationError(remoteError("invalid-frame", "unexpected remote offer"));
    }
    if (this.remoteOfferReceived) {
      throw new RemoteOperationError(remoteError("invalid-frame", "remote offer already received"));
    }
    this.remoteOfferReceived = true;
    return frame.sdp;
  }

  acceptAnswer(frame: Extract<SignalingFrame, { type: "answer" }>): string {
    if (this.role !== "host") {
      throw new RemoteOperationError(remoteError("invalid-frame", "unexpected remote answer"));
    }
    if (!this.offerSent || this.remoteAnswerReceived) {
      throw new RemoteOperationError(remoteError("invalid-frame", "unexpected remote answer"));
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
    return frame.candidate;
  }
}
