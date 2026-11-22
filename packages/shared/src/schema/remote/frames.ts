import { z } from "zod";
import { conversationSnapshotSchema } from "../conversation";
import { liveFrameSchema, sessionFrameSchema } from "../session/frame";
import {
  remoteCapabilitiesSchema,
  remoteProtocolVersionSchema,
  remoteRoleSchema,
} from "./capabilities";
import { remoteCommandSchema } from "./commands";
import { remoteErrorSchema } from "./errors";
import { remoteModelSettingsViewSchema } from "./modelSettings";

export const remoteHelloSchema = z.strictObject({
  type: z.literal("hello"),
  protocolVersion: remoteProtocolVersionSchema,
  role: remoteRoleSchema,
  sessionId: z.string(),
  peerId: z.string(),
  capabilities: remoteCapabilitiesSchema,
});

export const remoteAuthSchema = z.strictObject({
  type: z.literal("auth"),
  sessionId: z.string(),
  roomId: z.string(),
  keyId: z.string(),
  secret: z.string(),
});

export const remoteAuthErrorFrameSchema = z.strictObject({
  type: z.literal("auth-error"),
  error: remoteErrorSchema,
});

export const remoteWelcomeSchema = z.strictObject({
  type: z.literal("welcome"),
  protocolVersion: remoteProtocolVersionSchema,
  sessionId: z.string(),
  hostId: z.string(),
  leaseId: z.string(),
  capabilities: remoteCapabilitiesSchema,
  workspaceRoot: z.string(),
  modelSettings: remoteModelSettingsViewSchema.optional(),
});

export const remoteCommandFrameSchema = z.strictObject({
  type: z.literal("command"),
  requestId: z.string(),
  command: remoteCommandSchema,
});

export const remoteCommandOkFrameSchema = z.strictObject({
  type: z.literal("command-ok"),
  requestId: z.string(),
  value: z.unknown().optional(),
});

export const remoteCommandErrorFrameSchema = z.strictObject({
  type: z.literal("command-error"),
  requestId: z.string(),
  error: remoteErrorSchema,
});

export const remoteSnapshotFrameSchema = z.strictObject({
  type: z.literal("snapshot"),
  snapshot: conversationSnapshotSchema,
});

export const remoteSessionFrameSchema = z.strictObject({
  type: z.literal("session-frame"),
  frame: sessionFrameSchema,
});

export const remoteLiveFrameSchema = z.strictObject({
  type: z.literal("live-frame"),
  frame: liveFrameSchema,
});

export const remoteCloseFrameSchema = z.strictObject({
  type: z.literal("close"),
  reason: z.string().optional(),
});

export const remoteFrameSchema = z.discriminatedUnion("type", [
  remoteHelloSchema,
  remoteAuthSchema,
  remoteAuthErrorFrameSchema,
  remoteWelcomeSchema,
  remoteCommandFrameSchema,
  remoteCommandOkFrameSchema,
  remoteCommandErrorFrameSchema,
  remoteSnapshotFrameSchema,
  remoteSessionFrameSchema,
  remoteLiveFrameSchema,
  remoteCloseFrameSchema,
]);

export type RemoteHello = z.infer<typeof remoteHelloSchema>;
export type RemoteAuth = z.infer<typeof remoteAuthSchema>;
export type RemoteAuthErrorFrame = z.infer<typeof remoteAuthErrorFrameSchema>;
export type RemoteWelcome = z.infer<typeof remoteWelcomeSchema>;
export type RemoteCommandFrame = z.infer<typeof remoteCommandFrameSchema>;
export type RemoteCommandOkFrame = z.infer<typeof remoteCommandOkFrameSchema>;
export type RemoteCommandErrorFrame = z.infer<typeof remoteCommandErrorFrameSchema>;
export type RemoteSnapshotFrame = z.infer<typeof remoteSnapshotFrameSchema>;
export type RemoteSessionFrame = z.infer<typeof remoteSessionFrameSchema>;
export type RemoteLiveFrame = z.infer<typeof remoteLiveFrameSchema>;
export type RemoteCloseFrame = z.infer<typeof remoteCloseFrameSchema>;
export type RemoteFrame = z.infer<typeof remoteFrameSchema>;
