import type { RemoteError, RemoteErrorCode } from "@answra/shared/schema";

/** 远程命令失败的稳定错误；调用方按 code 判断，不解析文案。 */
export class RemoteOperationError extends Error {
  readonly code: RemoteErrorCode;
  readonly retryable: boolean;

  constructor(error: RemoteError) {
    super(error.message);
    this.name = "RemoteOperationError";
    this.code = error.code;
    this.retryable = error.retryable;
  }
}

export function remoteError(
  code: RemoteErrorCode,
  message: string,
  retryable = false,
): RemoteError {
  return { code, message, retryable };
}

export function toRemoteError(error: unknown): RemoteError {
  if (error instanceof RemoteOperationError) {
    return remoteError(error.code, error.message, error.retryable);
  }
  return remoteError("internal", "remote command failed");
}
