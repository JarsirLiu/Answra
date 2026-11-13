/** OpenAI-compatible provider 的唯一构造点；统一鉴权与 HTTP 重试边界。 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ConversationCapabilityEndpoint } from "@answra/shared";
import { createAuthorizedFetch, createLocalFetch } from "./providerFetch";
import { createRetryingFetch, type RetryAttempt } from "./retryFetch";

export function createModelProvider({
  endpoint,
  accessToken,
  tokenProvider,
  runId,
  onRetry,
  onRetryResume,
}: {
  endpoint: ConversationCapabilityEndpoint;
  accessToken: string;
  tokenProvider?: (options: { forceRefresh: boolean }) => Promise<string>;
  runId?: string;
  onRetry?: (retry: RetryAttempt) => Promise<void> | void;
  onRetryResume?: (retry: RetryAttempt) => Promise<void> | void;
}) {
  const baseFetch =
    endpoint.auth === "local"
      ? createLocalFetch(accessToken)
      : createAuthorizedFetch(accessToken, tokenProvider);
  return createOpenAICompatible({
    name: "answra",
    baseURL: endpoint.baseUrl,
    apiKey: accessToken || "local",
    fetch: createRetryingFetch(baseFetch, {
      ...(runId ? { runId } : {}),
      ...(onRetry ? { onRetry } : {}),
      ...(onRetryResume ? { onRetryResume } : {}),
    }),
  });
}
