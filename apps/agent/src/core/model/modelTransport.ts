/** AI SDK 模型请求的唯一执行入口：provider、端点 headers、会话头与重试边界。 */
import type { ConversationCapabilityEndpoint } from "@answra/shared";
import { generateText as generateTextSdk, streamText, type TextStreamPart, type ToolSet } from "ai";
import { createModelProvider } from "./provider";
import { requestHeadersFor } from "./requestHeaders";
import type { RetryAttempt } from "./retryFetch";

type StreamTextOptions = Parameters<typeof streamText>[0];
type GenerateTextOptions = Parameters<typeof generateTextSdk>[0];
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
    ...options,
    ...(headers === undefined ? {} : { headers }),
    abortSignal: signal,
    maxRetries: 0,
  });
  return result.fullStream;
}

export async function generateModelText({
  transport,
  prompt,
  temperature,
  signal,
}: {
  transport: ModelTransportOptions;
  prompt: string;
  temperature?: GenerateTextOptions["temperature"];
  signal?: AbortSignal;
}): Promise<string> {
  const provider = createProvider(transport);
  const headers = requestHeadersFor(transport.endpoint, transport.conversationId);
  const result = await generateTextSdk({
    model: provider(transport.endpoint.model),
    prompt,
    ...(temperature === undefined ? {} : { temperature }),
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
