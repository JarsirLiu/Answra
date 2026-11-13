/** host/controller 组合根与具体 WebRTC 实现之间的端口；测试注入 fake link。 */
import type { RemoteLink, Unsubscribe } from "@answra/remote";
import type { RemoteIceCandidate, RemoteRole } from "@answra/shared/schema";

/** WebRTC 协商所需的最小信令面；具体由 `RemoteSignalingSession` 满足。 */
export interface RemoteSignalingFacade {
  sendOffer(sdp: string): void;
  sendAnswer(sdp: string): void;
  sendIceCandidate(candidate: RemoteIceCandidate): void;
  onOffer(listener: (sdp: string) => void): Unsubscribe;
  onAnswer(listener: (sdp: string) => void): Unsubscribe;
  onIceCandidate(listener: (candidate: RemoteIceCandidate) => void): Unsubscribe;
}

export interface CreateRemoteLinkOptions {
  role: RemoteRole;
  signaling: RemoteSignalingFacade;
}

export type RemoteLinkFactory = (options: CreateRemoteLinkOptions) => RemoteLink;
