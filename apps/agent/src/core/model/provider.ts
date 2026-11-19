/** OpenAI-compatible provider 的唯一构造点；统一鉴权与 HTTP 重试边界。 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ConversationCapabilityEndpoint } from "@answra/shared";
import { createAuthorizedFetch, createLocalFetch } from "./providerFetch";
import { createRetryingFetch, type RetryAttempt } from "./retryFetch";

/** providerOptions 中承载厂商扩展字段的 key；必须与 provider 注册名一致。 */
export const MODEL_PROVIDER_NAME = "answra";

export function createModelProvider({
  endpoint,
  accessToken,
  tokenProvider,
  headers,
  runId,
  onRetry,
  onRetryResume,
}: {
  endpoint: ConversationCapabilityEndpoint;
  accessToken: string;
  tokenProvider?: (options: { forceRefresh: boolean }) => Promise<string>;
  headers?: Readonly<Record<string, string>>;
  runId?: string;
  onRetry?: (retry: RetryAttempt) => Promise<void> | void;
  onRetryResume?: (retry: RetryAttempt) => Promise<void> | void;
}) {
  const baseFetch =
    endpoint.auth === "local"
      ? createLocalFetch(accessToken)
      : createAuthorizedFetch(accessToken, tokenProvider);
  return createOpenAICompatible({
    name: MODEL_PROVIDER_NAME,
    baseURL: endpoint.baseUrl,
    apiKey: accessToken || "local",
    includeUsage: true,
    ...(headers === undefined ? {} : { headers: { ...headers } }),
    fetch: createRetryingFetch(baseFetch, {
      ...(runId ? { runId } : {}),
      ...(onRetry ? { onRetry } : {}),
      ...(onRetryResume ? { onRetryResume } : {}),
    }),
  });
}
