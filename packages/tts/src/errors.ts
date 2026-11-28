/**
 * 错误归一：所有失败都变成带稳定 code 的 TtsProviderError。
 *
 * code 与 retryable 来自 `@answra/shared/tts`，宿主只做一次映射，不二次分类。
 */
import { isRetryableTtsErrorCode, type TtsErrorCode } from "@answra/shared/tts";
import { DEFAULT_TTS_TIMEOUT_MS } from "./contracts";

export class TtsProviderError extends Error {
  readonly code: TtsErrorCode;
  readonly retryable: boolean;

  constructor(code: TtsErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TtsProviderError";
    this.code = code;
    this.retryable = isRetryableTtsErrorCode(code);
  }
}

export function isTtsProviderError(value: unknown): value is TtsProviderError {
  return value instanceof TtsProviderError;
}

export function abortedError(): TtsProviderError {
  return new TtsProviderError("aborted", "朗读已取消。");
}

/** HTTP 状态码到稳定错误码；不要在这里判断厂商业务码。 */
export function httpStatusError(status: number, detail: string): TtsProviderError {
  const suffix = detail === "" ? "" : `：${detail}`;
  const message = `TTS 服务返回 HTTP ${status}${suffix}`;
  if (status === 401 || status === 403) return new TtsProviderError("unauthorized", message);
  if (status === 429) return new TtsProviderError("rate-limited", message);
  if (status === 408 || status === 504) return new TtsProviderError("timeout", message);
  if (status >= 500) return new TtsProviderError("network", message);
  return new TtsProviderError("invalid-request", message);
}

/**
 * 组合取消信号：外部取消与超时各自保留原始 reason，
 * 便于把「用户取消」和「超时」区分开。
 */
export function createRequestSignal(
  source: AbortSignal | undefined,
  timeoutMs: number = DEFAULT_TTS_TIMEOUT_MS,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return source === undefined ? timeout : AbortSignal.any([source, timeout]);
}

/** fetch 抛错归一；必须传入实际使用的 signal 才能区分超时与取消。 */
export function mapRequestError(error: unknown, signal: AbortSignal): TtsProviderError {
  if (isTtsProviderError(error)) return error;
  if (error instanceof DOMException) {
    if (error.name === "TimeoutError") {
      return new TtsProviderError("timeout", "TTS 合成超时。", { cause: error });
    }
    if (error.name === "AbortError") return abortedError();
  }
  if (signal.reason instanceof DOMException && signal.reason.name === "TimeoutError") {
    return new TtsProviderError("timeout", "TTS 合成超时。", { cause: error });
  }
  const detail = error instanceof Error && error.message ? `：${error.message}` : "";
  return new TtsProviderError("network", `无法连接 TTS 服务${detail}`, { cause: error });
}

/** 读取错误响应正文的一小段用于诊断；避免把长响应塞进错误。 */
export async function readErrorDetail(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    return "";
  }
}
