/** 文件系统错误的窄分类；只在 workspace 边界把 Node 错误转成工具语义。 */

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isNotFound(error: unknown): boolean {
  return isErrorCode(error, "ENOENT");
}

export function isAlreadyExists(error: unknown): boolean {
  return isErrorCode(error, "EEXIST");
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
