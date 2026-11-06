/** 已认领 Conversation 回合的组合根：连接模型调用、流写入和终态收尾。 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ConversationCapabilityEndpoint, ConversationSendRequest } from "@answra/shared";
import type { RunOutcome } from "@answra/shared/schema";
import { stepCountIs, streamText, type ToolSet } from "ai";
import { consumeModelStream } from "../../core/model/consumeStream";
import { createRetryingFetch, RATE_LIMIT_RETRY_POLICY } from "../../core/model/retryFetch";
import type { ExecutionStore } from "../../execution/store";
import type { ConversationStore } from "../session/store";
import type { ConversationToolId } from "../tools/types";
import { createAuthorizedFetch, createLocalFetch } from "./endpointFetch";
import { summarizeModelError } from "./errorSummary";
import { buildModelMessages } from "./modelMessages";
import { createStreamJournal } from "./streamJournal";

/** 答题需要稳定但保留少量多样性；通用对话不覆盖提供商默认值。 */
const ANSWER_TEMPERATURE = 0.3;
/** 答题优先降低内部推理开销；不支持的 OpenAI-compatible 端点通常会忽略。 */
const ANSWER_REASONING_EFFORT = "low";

export interface ExecuteTurnOptions {
  conversationId: string;
  runId: string;
  endpoint: ConversationCapabilityEndpoint;
  getAccessToken: () => Promise<string>;
  request: ConversationSendRequest;
  controller: AbortController;
  systemPrompt: string;
  includeHistory: boolean;
  ephemeral: boolean;
  injectTime: boolean;
  authorizedTools: readonly ConversationToolId[];
  workspaceRoot: string | null;
  tokenProvider?: (options: { forceRefresh: boolean }) => Promise<string>;
  store: ConversationStore;
  executionStore: ExecutionStore;
  createTools: (
    ids: readonly ConversationToolId[],
    context: { workspaceRoot: string | null; signal: AbortSignal },
  ) => ToolSet | undefined;
  onFinished: (runId: string) => void;
}

/** 执行已由 session store 原子认领的 assistant 回合，并负责终态收尾。 */
export async function executeTurn(options: ExecuteTurnOptions): Promise<void> {
  const journal = createStreamJournal(options);
  let finishReason: string | undefined;
  let executionStarted = false;
  const startedAt = Date.now();
  try {
    await options.executionStore.startRun({
      runId: options.runId,
      conversationId: options.conversationId,
      producerId: "answra-agent",
    });
    executionStarted = true;
    const accessToken = await options.getAccessToken();
    await options.executionStore.transition(options.runId, "running");
    logTurnStarted(options);
    const baseFetch =
      options.endpoint.auth === "local"
        ? createLocalFetch(accessToken)
        : createAuthorizedFetch(accessToken, options.tokenProvider);
    const provider = createOpenAICompatible({
      name: "answra",
      baseURL: options.endpoint.baseUrl,
      apiKey: accessToken || "local",
      fetch: createRetryingFetch(baseFetch, {
        runId: options.runId,
        onRetry: async (retry) => {
          await options.executionStore.scheduleRetry(options.runId, retry);
          await journal.append({
            type: "retry",
            kind: retry.kind,
            attempt: retry.attempt,
            maxRetries: retry.maxRetries,
            delayMs: retry.delayMs,
          });
        },
        onRetryResume: () => options.executionStore.resumeRetry(options.runId),
      }),
    });
    const messages = await buildModelMessages({
      conversationId: options.conversationId,
      request: options.request,
      includeHistory: options.includeHistory,
      injectTime: options.injectTime,
      store: options.store,
    });
    const tools = options.authorizedTools.length
      ? options.createTools(options.authorizedTools, {
          workspaceRoot: options.workspaceRoot,
          signal: options.controller.signal,
        })
      : undefined;
    const result = streamText({
      model: provider(options.endpoint.model),
      system: options.systemPrompt,
      messages,
      abortSignal: options.controller.signal,
      maxRetries: 0,
      ...(options.ephemeral
        ? {
            temperature: ANSWER_TEMPERATURE,
            providerOptions: {
              openaiCompatible: { reasoningEffort: ANSWER_REASONING_EFFORT },
            },
          }
        : {}),
      ...(tools ? { tools, stopWhen: stepCountIs(6) } : {}),
      onError: ({ error }) => {
        console.error("[conversation][run] provider error", {
          runId: options.runId,
          ...summarizeModelError(error),
        });
      },
      onFinish: ({ finishReason: reason, text, reasoningText, toolCalls, usage, totalUsage }) => {
        finishReason = reason;
        console.info("[conversation][run] model finished", {
          runId: options.runId,
          finishReason: reason,
          textLength: text.length,
          reasoningLength: reasoningText?.length ?? 0,
          toolCallCount: toolCalls.length,
          usage,
          totalUsage,
        });
      },
    });
    await consumeModelStream(
      result.toUIMessageStream({
        generateMessageId: () => options.runId,
        onError: (error) => (error instanceof Error ? error.message.slice(0, 300) : "模型请求失败"),
      }),
      journal.append,
    );
  } catch (error) {
    await handleTurnError(options, journal, error, startedAt);
  } finally {
    await finishTurn(options, journal.metrics, finishReason, startedAt, executionStarted);
    options.onFinished(options.runId);
  }
}

function logTurnStarted(options: ExecuteTurnOptions): void {
  console.info("[conversation][run] started", {
    runId: options.runId,
    model: options.endpoint.model,
    host: new URL(options.endpoint.baseUrl).host,
    imageCount: options.request.images.length,
    textLength: options.request.text.length,
    includeHistory: options.includeHistory,
    ephemeral: options.ephemeral,
    toolCount: options.authorizedTools.length,
    maxRetries: 0,
    rateLimitRetries: RATE_LIMIT_RETRY_POLICY.maxRetries,
  });
}

async function handleTurnError(
  options: ExecuteTurnOptions,
  journal: ReturnType<typeof createStreamJournal>,
  error: unknown,
  startedAt: number,
): Promise<void> {
  console.error("[conversation][run] failed", {
    runId: options.runId,
    elapsedMs: Date.now() - startedAt,
    ...summarizeModelError(error),
  });
  if (!journal.metrics.started) await journal.append({ type: "start" });
  if (!options.controller.signal.aborted) {
    await journal.append({
      type: "error",
      errorText: error instanceof Error ? error.message : "模型请求失败",
    });
  }
}

async function finishTurn(
  options: ExecuteTurnOptions,
  metrics: ReturnType<typeof createStreamJournal>["metrics"],
  finishReason: string | undefined,
  startedAt: number,
  executionStarted: boolean,
): Promise<void> {
  const outcome: RunOutcome = options.controller.signal.aborted
    ? "aborted"
    : metrics.failed
      ? "failed"
      : "completed";
  const executionOutcome: Extract<RunOutcome, "completed" | "failed" | "aborted"> =
    outcome === "completed" ? "completed" : outcome === "aborted" ? "aborted" : "failed";
  if (executionStarted) await options.executionStore.finishRun(options.runId, executionOutcome);
  await options.store.finishRun(options.conversationId, options.runId, outcome);
  if (options.ephemeral && !metrics.failed) await options.store.clear(options.conversationId);
  console.info("[conversation][run] finished", {
    runId: options.runId,
    elapsedMs: Date.now() - startedAt,
    outcome,
    finishReason,
    textLength: metrics.textLength,
    reasoningLength: metrics.reasoningLength,
    chunkCounts: metrics.chunkCounts,
    cancelled: options.controller.signal.aborted,
  });
}
