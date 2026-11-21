import type { RemoteErrorCode } from "@answra/shared/schema";
import { RemoteOperationError, remoteError } from "../protocol/errors";

const TERMINAL_CODES = new Set<RemoteErrorCode>([
  "unsupported-version",
  "unauthorized",
  "session-mismatch",
  "controller-busy",
  "room-conflict",
  "run-active",
  "invalid-frame",
  "invalid-command",
  "not-found",
  "key-expired",
  "key-revoked",
  "internal",
]);

/** 连接层终态：身份/房间/协议错误重试不会变好；链路错误才进入退避。 */
export function isTerminalRemoteError(error: unknown): boolean {
  if (!(error instanceof RemoteOperationError)) return false;
  return TERMINAL_CODES.has(error.code);
}

export function toRemoteUnreachable(error?: unknown): RemoteOperationError {
  const suffix = error instanceof Error && error.message.length > 0 ? `: ${error.message}` : "";
  return new RemoteOperationError(
    remoteError("remote-unreachable", `remote connection could not be restored${suffix}`, true),
  );
}
