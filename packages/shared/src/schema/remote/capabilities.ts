import { z } from "zod";

/** 远程协议的当前版本；版本不匹配时由边界直接拒绝。 */
export const REMOTE_PROTOCOL_VERSION = 1 as const;

export const remoteProtocolVersionSchema = z.literal(REMOTE_PROTOCOL_VERSION);
export const remoteRoleSchema = z.enum(["host", "controller"]);

/** Host 实际可提供的远程能力；controller 只按这里声明渲染入口。 */
export const remoteCapabilitySchema = z.enum([
  "coding",
  "multi-bot",
  "team",
  "handoff",
  "model-settings",
  "sessions",
]);

export const remoteCapabilitiesSchema = z.array(remoteCapabilitySchema);

export type RemoteRole = z.infer<typeof remoteRoleSchema>;
export type RemoteCapability = z.infer<typeof remoteCapabilitySchema>;
