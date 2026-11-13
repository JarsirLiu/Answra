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

export const signalingFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("join"),
    roomId: z.string(),
    peerId: z.string(),
    role: remoteRoleSchema,
    protocolVersion: remoteProtocolVersionSchema,
  }),
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
export type SignalingFrame = z.infer<typeof signalingFrameSchema>;
