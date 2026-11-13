import { z } from "zod";

/** 远程链路的稳定失败码；UI 不解析文案。 */
export const remoteErrorCodeSchema = z.enum([
  "unsupported-version",
  "unauthorized",
  "session-mismatch",
  "controller-busy",
  "run-active",
  "invalid-frame",
  "invalid-command",
  "not-found",
  "host-unavailable",
  "remote-disconnected",
  "remote-unreachable",
  "key-expired",
  "key-revoked",
  "transport-closed",
  "timeout",
  "internal",
]);

export const remoteErrorSchema = z.strictObject({
  code: remoteErrorCodeSchema,
  /** 面向用户的短说明；协议判断只能使用 code。 */
  message: z.string(),
  /** 仅表示调用方是否可安全重试；不代表 host 状态未变。 */
  retryable: z.boolean(),
});

export type RemoteErrorCode = z.infer<typeof remoteErrorCodeSchema>;
export type RemoteError = z.infer<typeof remoteErrorSchema>;
