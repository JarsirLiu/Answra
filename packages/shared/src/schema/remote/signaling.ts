import { z } from "zod";
import { remoteProtocolVersionSchema, remoteRoleSchema } from "./capabilities";
import { remoteErrorSchema } from "./errors";

/** 控制面只转发房间、SDP 与 ICE，不承载业务消息。 */
export const remoteIceCandidateSchema = z.strictObject({
  candidate: z.string(),
  sdpMid: z.string().optional(),
  sdpMLineIndex: z.number().int().nonnegative().optional(),
  usernameFragment: z.string().optional(),
});

export const signalingPeerSchema = z.strictObject({
  peerId: z.string(),
  role: remoteRoleSchema,
});

export const signalingJoinedFrameSchema = z.strictObject({
  type: z.literal("joined"),
  roomId: z.string(),
  peerId: z.string(),
  role: remoteRoleSchema,
  peers: z.array(signalingPeerSchema),
});

export const signalingJoinRejectedFrameSchema = z.strictObject({
  type: z.literal("join-rejected"),
  error: remoteErrorSchema,
});

export const signalingFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("join"),
    roomId: z.string(),
    peerId: z.string(),
    role: remoteRoleSchema,
    protocolVersion: remoteProtocolVersionSchema,
  }),
  signalingJoinedFrameSchema,
  signalingJoinRejectedFrameSchema,
  z.strictObject({
    type: z.literal("peer-joined"),
    peerId: z.string(),
    role: remoteRoleSchema,
  }),
  z.strictObject({
    type: z.literal("offer"),
    fromPeerId: z.string(),
    sdp: z.string(),
  }),
  z.strictObject({
    type: z.literal("answer"),
    fromPeerId: z.string(),
    sdp: z.string(),
  }),
  z.strictObject({
    type: z.literal("ice-candidate"),
    fromPeerId: z.string(),
    candidate: remoteIceCandidateSchema,
  }),
  z.strictObject({
    type: z.literal("peer-left"),
    peerId: z.string(),
  }),
  z.strictObject({
    type: z.literal("error"),
    error: remoteErrorSchema,
  }),
]);

export type RemoteIceCandidate = z.infer<typeof remoteIceCandidateSchema>;
export type SignalingPeer = z.infer<typeof signalingPeerSchema>;
export type SignalingJoined = z.infer<typeof signalingJoinedFrameSchema>;
export type SignalingJoinRejected = z.infer<typeof signalingJoinRejectedFrameSchema>;
export type SignalingFrame = z.infer<typeof signalingFrameSchema>;
