/** 执行已注册 Agent 的 AI SDK 流、HTTP 重试与 run 终态；不读取或写入 transcript。 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ConversationCapabilityEndpoint } from "@answra/shared";
import type { RunOutcome } from "@answra/shared/schema";
import {
  type OnToolCallFinishEvent,
  type OnToolCallStartEvent,
  streamText,
  type ToolSet,
} from "ai";
import type { ExecutionStore } from "../../execution/store";
import { consumeModelStream } from "../model/consumeStream";
import { summarizeModelError } from "../model/errorSummary";
import { createAuthorizedFetch, createLocalFetch } from "../model/providerFetch";
import { createRetryingFetch, RATE_LIMIT_RETRY_POLICY } from "../model/retryFetch";
import type { AgentDefinition, AgentRunRequest } from "./definition";
import { createExecutionJournal } from "./streamJournal";

/** 单次工具调用实时输出的字符上限，避免长命令把事件日志撑爆。 */
const MAX_LIVE_TOOL_OUTPUT_CHARS = 8_000;

export async function executeRun<Input, Prepared>({
  definition,
  request,
  input,
  runId,
  endpoint,
  executionStore,
  tokenProvider,
  controller,
}: {
  definition: AgentDefinition<Input>;
  request: AgentRunRequest<Input, Prepared>;
  input: Input;
  runId: string;
  endpoint: ConversationCapabilityEndpoint;
  executionStore: ExecutionStore;
  tokenProvider?: (options: { forceRefresh: boolean }) => Promise<string>;
  controller: AbortController;
}): Promise<RunOutcome> {
  const { conversationId, onEvent } = request;
  const journal = createExecutionJournal({ runId, executionStore, onEvent });
  const startedAt = Date.now();
  let finishReason: string | undefined;
  let executionStarted = false;
  let outcome: RunOutcome = "failed";

  try {
    const initialEvents = await executionStore.startRun({
      runId,
      conversationId,
      producerId: "answra-agent",
    });
    executionStarted = true;
    for (const event of initialEvents) await journal.notify(event);

    const accessToken = await request.getAccessToken();
    const liveOutput = createLiveToolOutputRelay(journal);
    const modelRequest = await definition.prepare(input, controller.signal, {
      toolOutput: liveOutput.emit,
    });
    await journal.notify(await executionStore.transition(runId, "running"));
    logRunStarted({ runId, agentId: definition.id, endpoint });

    const baseFetch =
      endpoint.auth === "local"
        ? createLocalFetch(accessToken)
        : createAuthorizedFetch(accessToken, tokenProvider);
    const provider = createOpenAICompatible({
      name: "answra",
      baseURL: endpoint.baseUrl,
      apiKey: accessToken || "local",
      fetch: createRetryingFetch(baseFetch, {
        runId,
        onRetry: async (retry) => {
          await journal.notify(await executionStore.scheduleRetry(runId, retry));
          await journal.append({
            type: "retry",
            kind: retry.kind,
            attempt: retry.attempt,
            maxRetries: retry.maxRetries,
            delayMs: retry.delayMs,
          });
        },
        onRetryResume: async () => {
          await journal.notify(await executionStore.resumeRetry(runId));
        },
      }),
    });

    const result = streamText({
      model: provider(endpoint.model),
      ...modelRequest,
      abortSignal: controller.signal,
      maxRetries: 0,
      onError: ({ error }) => {
        console.error("[agent][run] provider error", {
          runId,
          ...summarizeModelError(error),
        });
      },
      onFinish: ({ finishReason: reason, text, reasoningText, toolCalls, usage, totalUsage }) => {
        finishReason = reason;
        console.info("[agent][run] model finished", {
          runId,
          finishReason: reason,
          textLength: text.length,
          reasoningLength: reasoningText?.length ?? 0,
          toolCallCount: toolCalls.length,
          usage,
          totalUsage,
        });
      },
      experimental_onToolCallStart: async (event: OnToolCallStartEvent<ToolSet>) => {
        await journal.append({
          type: "tool-execution-started",
          toolCallId: event.toolCall.toolCallId,
          toolName: event.toolCall.toolName,
          input: event.toolCall.input,
          ...(event.stepNumber === undefined ? {} : { stepNumber: event.stepNumber }),
        });
      },
      experimental_onToolCallFinish: async (event: OnToolCallFinishEvent<ToolSet>) => {
        await liveOutput.flush();
        const common = {
          type: "tool-execution-finished" as const,
          toolCallId: event.toolCall.toolCallId,
          toolName: event.toolCall.toolName,
          input: event.toolCall.input,
          durationMs: event.durationMs,
          ...(event.stepNumber === undefined ? {} : { stepNumber: event.stepNumber }),
        };
        await journal.append(
          event.success
            ? { ...common, result: { success: true, output: event.output } }
            : { ...common, result: { success: false, errorText: errorText(event.error) } },
        );
      },
    });

    await consumeModelStream(result.fullStream, journal.append);
    // The SDK can report a provider/network error and then close without a finish
    // event. That error is already the authoritative terminal fact; only synthesize
    // the diagnostic when the stream ended without either success or failure.
    if (
      !journal.metrics.finished &&
      !journal.metrics.failed &&
      !journal.metrics.aborted &&
      !controller.signal.aborted
    ) {
      await journal.append({ type: "error", errorText: "模型流未提供终态" });
    }
  } catch (error) {
    logRunFailed(runId, startedAt, error);
    if (executionStarted && !journal.metrics.started) await journal.append({ type: "start" });
    if (executionStarted && !controller.signal.aborted) {
      await journal.append({
        type: "error",
        errorText: error instanceof Error ? error.message : "模型请求失败",
      });
    }
  } finally {
    outcome = runOutcome(controller.signal.aborted, journal.metrics, finishReason);
    if (executionStarted) {
      const terminal = await executionStore.finishRun(runId, outcome);
      if (terminal) await journal.notify(terminal);
    }
    logRunFinished({ runId, startedAt, outcome, finishReason, metrics: journal.metrics });
  }

  return outcome;
}

export function runOutcome(
  cancelled: boolean,
  metrics: ReturnType<typeof createExecutionJournal>["metrics"],
  finishReason: string | undefined,
): Extract<RunOutcome, "completed" | "failed" | "aborted"> {
  if (cancelled || metrics.aborted) return "aborted";
  if (metrics.failed || !metrics.finished || finishReason === "tool-calls") return "failed";
  return "completed";
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "工具执行失败";
}

/**
 * Serializes live tool output into the journal so deltas always precede the tool's
 * terminal event. Deltas are capped per tool call; the final result still carries
 * the full (budgeted) output.
 */
function createLiveToolOutputRelay(journal: ReturnType<typeof createExecutionJournal>) {
  let chain: Promise<void> = Promise.resolve();
  const emittedChars = new Map<string, number>();
  return {
    emit(toolCallId: string, delta: string): void {
      if (!delta) return;
      const emitted = emittedChars.get(toolCallId) ?? 0;
      if (emitted >= MAX_LIVE_TOOL_OUTPUT_CHARS) return;
      const room = MAX_LIVE_TOOL_OUTPUT_CHARS - emitted;
      const chunk = delta.length > room ? delta.slice(0, room) : delta;
      emittedChars.set(toolCallId, emitted + chunk.length);
      chain = chain
        .then(() => journal.append({ type: "tool-output-delta", toolCallId, delta: chunk }))
        .catch(() => undefined);
    },
    flush(): Promise<void> {
      return chain;
    },
  };
}

function logRunStarted({
  runId,
  agentId,
  endpoint,
}: {
  runId: string;
  agentId: string;
  endpoint: ConversationCapabilityEndpoint;
}): void {
  console.info("[agent][run] started", {
    runId,
    agentId,
    model: endpoint.model,
    host: new URL(endpoint.baseUrl).host,
    maxRetries: 0,
    rateLimitRetries: RATE_LIMIT_RETRY_POLICY.maxRetries,
  });
}

function logRunFailed(runId: string, startedAt: number, error: unknown): void {
  console.error("[agent][run] failed", {
    runId,
    elapsedMs: Date.now() - startedAt,
    ...summarizeModelError(error),
  });
}

function logRunFinished({
  runId,
  startedAt,
  outcome,
  finishReason,
  metrics,
}: {
  runId: string;
  startedAt: number;
  outcome: RunOutcome;
  finishReason: string | undefined;
  metrics: ReturnType<typeof createExecutionJournal>["metrics"];
}): void {
  console.info("[agent][run] finished", {
    runId,
    elapsedMs: Date.now() - startedAt,
    outcome,
    finishReason,
    textLength: metrics.textLength,
    reasoningLength: metrics.reasoningLength,
    chunkCounts: metrics.chunkCounts,
    cancelled: metrics.aborted,
  });
}
