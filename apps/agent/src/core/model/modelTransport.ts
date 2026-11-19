/** AI SDK 模型请求的唯一执行入口：provider、端点 headers、会话头与重试边界。 */
import type { ConversationCapabilityEndpoint } from "@answra/shared";
import { generateText as generateTextSdk, streamText, type TextStreamPart, type ToolSet } from "ai";
import { createModelProvider, MODEL_PROVIDER_NAME } from "./provider";
import { requestHeadersFor } from "./requestHeaders";
import type { RetryAttempt } from "./retryFetch";

type StreamTextOptions = Parameters<typeof streamText>[0];
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type ModelStreamOptions = DistributiveOmit<
  StreamTextOptions,
  "model" | "headers" | "abortSignal" | "maxRetries"
>;

export interface ModelTransportOptions {
  endpoint: ConversationCapabilityEndpoint;
  accessToken: string;
  tokenProvider?: (options: { forceRefresh: boolean }) => Promise<string>;
  conversationId: string;
  runId?: string;
  onRetry?: (retry: RetryAttempt) => Promise<void> | void;
  onRetryResume?: (retry: RetryAttempt) => Promise<void> | void;
}

export function streamModel({
  transport,
  options,
  signal,
}: {
  transport: ModelTransportOptions;
  options: ModelStreamOptions;
  signal: AbortSignal;
}): AsyncIterable<TextStreamPart<ToolSet>> {
  const provider = createProvider(transport);
  const headers = requestHeadersFor(transport.endpoint, transport.conversationId);
  const result = streamText({
    model: provider(transport.endpoint.model),
    ...withEndpointProviderOptions(options, transport.endpoint),
    ...(headers === undefined ? {} : { headers }),
    abortSignal: signal,
    maxRetries: 0,
  });
  return result.fullStream;
}

/**
 * 端点声明的厂商扩展参数并入 providerOptions。`@ai-sdk/openai-compatible` 只把
 * provider 注册名下的未知 key 写进请求体，因此必须挂在 {@link MODEL_PROVIDER_NAME}。
 */
function withEndpointProviderOptions(
  options: ModelStreamOptions,
  endpoint: ConversationCapabilityEndpoint,
): ModelStreamOptions {
  const vendor = endpoint.providerOptions;
  if (vendor === undefined || Object.keys(vendor).length === 0) return options;
  const providerOptions = options.providerOptions ?? {};
  const existing = providerOptions[MODEL_PROVIDER_NAME];
  return {
    ...options,
    providerOptions: {
      ...providerOptions,
      [MODEL_PROVIDER_NAME]: {
        ...(isPlainRecord(existing) ? existing : {}),
        ...vendor,
      },
    } as ModelStreamOptions["providerOptions"],
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function generateModelText({
  transport,
  prompt,
  signal,
}: {
  transport: ModelTransportOptions;
  prompt: string;
  signal?: AbortSignal;
}): Promise<string> {
  const provider = createProvider(transport);
  const headers = requestHeadersFor(transport.endpoint, transport.conversationId);
  const result = await generateTextSdk({
    model: provider(transport.endpoint.model),
    prompt,
    ...(headers === undefined ? {} : { headers }),
    ...(signal === undefined ? {} : { abortSignal: signal }),
    maxRetries: 0,
  });
  return result.text;
}

function createProvider({
  endpoint,
  accessToken,
  tokenProvider,
  runId,
  onRetry,
  onRetryResume,
}: ModelTransportOptions) {
  return createModelProvider({
    endpoint,
    accessToken,
    ...(tokenProvider === undefined ? {} : { tokenProvider }),
    ...(endpoint.headers === undefined ? {} : { headers: endpoint.headers }),
    ...(runId === undefined ? {} : { runId }),
    ...(onRetry === undefined ? {} : { onRetry }),
    ...(onRetryResume === undefined ? {} : { onRetryResume }),
  });
}
