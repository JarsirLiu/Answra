/**
 * 把模型 SDK 的未知错误转换为有界日志字段。
 * 不把供应商错误对象本身透传到日志之外的产品契约。
 */
type ModelErrorSummary = {
  errorName: string;
  error: string;
  statusCode?: number;
  urlHost?: string;
  isRetryable?: boolean;
  responseBody?: string;
  retryReason?: string;
  attempts?: ModelErrorSummary[];
  lastError?: ModelErrorSummary;
};

export function summarizeModelError(error: unknown, depth = 0): ModelErrorSummary {
  const value = error as {
    name?: unknown;
    message?: unknown;
    statusCode?: unknown;
    url?: unknown;
    isRetryable?: unknown;
    responseBody?: unknown;
    reason?: unknown;
    errors?: unknown;
    lastError?: unknown;
  } | null;
  const summary: ModelErrorSummary = {
    errorName: typeof value?.name === "string" ? value.name : "Error",
    error: typeof value?.message === "string" ? value.message.slice(0, 500) : "模型请求失败",
  };
  if (typeof value?.statusCode === "number") summary.statusCode = value.statusCode;
  if (typeof value?.url === "string") {
    try {
      summary.urlHost = new URL(value.url).host;
    } catch {
      // 非法 URL 只影响诊断字段，不改变模型请求结果。
    }
  }
  if (typeof value?.isRetryable === "boolean") summary.isRetryable = value.isRetryable;
  if (typeof value?.responseBody === "string")
    summary.responseBody = value.responseBody.slice(0, 2_000);
  if (typeof value?.reason === "string") summary.retryReason = value.reason;
  if (depth < 2 && Array.isArray(value?.errors)) {
    summary.attempts = value.errors.map((item) => summarizeModelError(item, depth + 1));
  }
  if (depth < 2 && value?.lastError !== undefined) {
    summary.lastError = summarizeModelError(value.lastError, depth + 1);
  }
  return summary;
}
