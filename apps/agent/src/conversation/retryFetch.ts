export interface RetryPolicy {
  /** Number of retries after the first attempt. */
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  jitterMs: number;
}

export const RATE_LIMIT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 5,
  initialDelayMs: 5_000,
  maxDelayMs: 60_000,
  jitterMs: 250,
};

export const SERVER_ERROR_RETRY_POLICY: RetryPolicy = {
  maxRetries: 2,
  initialDelayMs: 1_000,
  maxDelayMs: 8_000,
  jitterMs: 100,
};

export interface RetryAttempt {
  kind: "rate-limit" | "server-error" | "network-error";
  attempt: number;
  maxRetries: number;
  delayMs: number;
  statusCode?: number;
}

const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export interface RetryingFetchOptions {
  runId?: string;
  rateLimit?: Partial<RetryPolicy>;
  serverError?: Partial<RetryPolicy>;
  onRetry?: (retry: RetryAttempt) => Promise<void> | void;
  sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
  log?: (message: string, details: Record<string, unknown>) => void;
}

/**
 * Retries replayable OpenAI-compatible requests at the HTTP boundary.
 * AI SDK's built-in retry is intentionally disabled so a 429 gets a minute-scale
 * backoff instead of the SDK's 2s/4s schedule.
 */
export function createRetryingFetch(
  baseFetch: typeof fetch,
  options: RetryingFetchOptions = {},
): typeof fetch {
  const rateLimit = { ...RATE_LIMIT_RETRY_POLICY, ...options.rateLimit };
  const serverError = { ...SERVER_ERROR_RETRY_POLICY, ...options.serverError };
  const sleep = options.sleep ?? sleepWithAbort;
  const log = options.log ?? ((message, details) => console.warn(message, details));

  return async (input, init) => {
    const retryCounts = new Map<RetryAttempt["kind"], number>();
    while (true) {
      let response: Response;
      try {
        response = await baseFetch(input, init);
      } catch (error) {
        const errorCode = networkErrorCode(error);
        const kind = "network-error" as const;
        const retries = retryCounts.get(kind) ?? 0;
        if (
          !isRetryableNetworkError(error) ||
          retries >= serverError.maxRetries ||
          input instanceof Request ||
          !isReplayableBody(init?.body)
        ) {
          throw error;
        }
        const delayMs = backoffDelayMs(serverError, retries);
        const retry: RetryAttempt = {
          kind,
          attempt: retries + 1,
          maxRetries: serverError.maxRetries,
          delayMs,
        };
        log("[conversation][run] retrying model request", {
          ...(options.runId ? { runId: options.runId } : {}),
          attempt: retry.attempt,
          maxRetries: retry.maxRetries,
          delayMs,
          errorCode,
          urlHost: requestHost(input),
        });
        await options.onRetry?.(retry);
        await sleep(delayMs, init?.signal);
        retryCounts.set(kind, retries + 1);
        continue;
      }

      const retryRule = retryRuleFor(response.status, rateLimit, serverError);
      const retries = retryRule ? (retryCounts.get(retryRule.kind) ?? 0) : 0;
      const policy = retryRule?.policy;
      if (!policy || retries >= policy.maxRetries) return response;
      if (input instanceof Request || !isReplayableBody(init?.body)) return response;

      const delayMs = retryDelayMs(response, policy, retries);
      const retry: RetryAttempt = {
        kind: retryRule.kind,
        attempt: retries + 1,
        maxRetries: policy.maxRetries,
        delayMs,
        statusCode: response.status,
      };
      log("[conversation][run] retrying model request", {
        ...(options.runId ? { runId: options.runId } : {}),
        status: response.status,
        attempt: retry.attempt,
        maxRetries: retry.maxRetries,
        delayMs,
        urlHost: requestHost(input),
      });
      await options.onRetry?.(retry);
      await discardBody(response);
      await sleep(delayMs, init?.signal);
      retryCounts.set(retryRule.kind, retries + 1);
    }
  };
}

function retryRuleFor(
  status: number,
  rateLimit: RetryPolicy,
  serverError: RetryPolicy,
): { kind: RetryAttempt["kind"]; policy: RetryPolicy } | undefined {
  if (status === 429) return { kind: "rate-limit", policy: rateLimit };
  if (status === 408 || status === 409 || status >= 500)
    return { kind: "server-error", policy: serverError };
  return undefined;
}

function retryDelayMs(response: Response, policy: RetryPolicy, retries: number): number {
  const retryAfter = retryAfterMs(response);
  if (retryAfter !== undefined) {
    return Math.min(policy.maxDelayMs, Math.max(0, retryAfter));
  }
  return backoffDelayMs(policy, retries);
}

function backoffDelayMs(policy: RetryPolicy, retries: number): number {
  const exponential = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** retries);
  const jitter = Math.floor(Math.random() * (policy.jitterMs + 1));
  return Math.min(policy.maxDelayMs, exponential + jitter);
}

function retryAfterMs(response: Response): number | undefined {
  const retryAfterMsHeader = response.headers.get("retry-after-ms");
  if (retryAfterMsHeader) {
    const ms = Number.parseFloat(retryAfterMsHeader);
    if (Number.isFinite(ms)) return ms;
  }
  const retryAfterHeader = response.headers.get("retry-after");
  if (!retryAfterHeader) return undefined;
  const seconds = Number.parseFloat(retryAfterHeader);
  if (Number.isFinite(seconds)) return seconds * 1_000;
  const date = Date.parse(retryAfterHeader);
  return Number.isFinite(date) ? date - Date.now() : undefined;
}

function isReplayableBody(body: unknown): boolean {
  if (body == null) return true;
  if (typeof body === "string") return true;
  if (body instanceof URLSearchParams) return true;
  if (body instanceof ArrayBuffer) return true;
  if (ArrayBuffer.isView(body)) return true;
  return typeof Blob !== "undefined" && body instanceof Blob;
}

function isRetryableNetworkError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return false;
  const code = networkErrorCode(error);
  return code !== undefined && NETWORK_ERROR_CODES.has(code);
}

function networkErrorCode(error: unknown): string | undefined {
  const value = error as { code?: unknown; cause?: unknown } | null;
  if (typeof value?.code === "string") return value.code;
  const cause = value?.cause as { code?: unknown } | null;
  return typeof cause?.code === "string" ? cause.code : undefined;
}

function requestHost(input: Parameters<typeof fetch>[0]): string | undefined {
  try {
    if (typeof input === "string") return new URL(input).host;
    if (input instanceof URL) return input.host;
    if (input instanceof Request) return new URL(input.url).host;
  } catch {
    return undefined;
  }
  return undefined;
}

async function discardBody(response: Response): Promise<void> {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch {
    // Draining a failed response is best-effort.
  }
}

function sleepWithAbort(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    function onAbort() {
      cleanup();
      reject(signal?.reason ?? new Error("aborted"));
    }
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
