import {
  type RemoteFrame,
  remoteFrameSchema,
  type SignalingFrame,
  signalingFrameSchema,
} from "@answra/shared/schema";

/** 线协议编解码；只在传输边界使用，内部模块继续使用已校验类型。 */
export function encodeRemoteFrame(frame: RemoteFrame): string {
  return JSON.stringify(remoteFrameSchema.parse(frame));
}

export function decodeRemoteFrame(encoded: string): RemoteFrame {
  return remoteFrameSchema.parse(JSON.parse(encoded) as unknown);
}

export function encodeSignalingFrame(frame: SignalingFrame): string {
  return JSON.stringify(signalingFrameSchema.parse(frame));
}

export function decodeSignalingFrame(encoded: string): SignalingFrame {
  return signalingFrameSchema.parse(JSON.parse(encoded) as unknown);
}
