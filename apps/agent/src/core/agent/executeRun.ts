/** 执行已注册 Agent 的 AI SDK 流、HTTP 重试与 run 终态；不读取或写入 transcript。 */
import type { ConversationCapabilityEndpoint } from "@answra/shared";
import type { AgentEvent, RunOutcome } from "@answra/shared/schema";
import type { ExecutionStore } from "../../execution/store";
import { isContextOverflowError } from "../model/contextOverflow";
import { summarizeModelError } from "../model/errorSummary";
import { streamModel } from "../model/modelTransport";
import { RATE_LIMIT_RETRY_POLICY, type RetryAttempt } from "../model/retryFetch";
import type {
  AgentDefinition,
  AgentModelRequest,
  AgentRunRequest,
  AgentToolOutputEmitter,
} from "./definition";
import { consumeModelAttempt, createModelAttemptSink } from "./modelAttempt";
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
    let modelRequest = await prepareModelRequest({
      definition,
      request,
      input,
      signal: controller.signal,
      emitter: { toolOutput: liveOutput.emit },
    });
    await journal.notify(await executionStore.transition(runId, "running"));
    logRunStarted({ runId, agentId: definition.id, endpoint });

    const transport = {
      endpoint,
      accessToken,
      conversationId,
      runId,
      ...(tokenProvider === undefined ? {} : { tokenProvider }),
      onRetry: async (retry: RetryAttempt) => {
        const facts = {
          kind: retry.kind,
          attempt: retry.attempt,
          maxRetries: retry.maxRetries,
          delayMs: retry.delayMs,
          ...(retry.statusCode === undefined ? {} : { statusCode: retry.statusCode }),
        };
        await journal.notify(await executionStore.scheduleRetry(runId, facts));
        await journal.append({ type: "retry", ...facts });
      },
      onRetryResume: async () => {
        await journal.notify(await executionStore.resumeRetry(runId));
      },
    };

    let contextRecovered = false;
    for (;;) {
      const attempt = createModelAttemptSink(journal);
      const attemptLiveOutput = createLiveToolOutputRelay(attempt);
      let failure: { error: unknown; errorText: string } | undefined;

      try {
        const result = streamModel({
          transport,
          signal: controller.signal,
          options: {
            ...modelRequest,
            onError: ({ error }) => {
              console.error("[agent][run] provider error", {
                runId,
                ...summarizeModelError(error),
              });
            },
            onFinish: ({
              finishReason: reason,
              text,
              reasoningText,
              toolCalls,
              usage,
              totalUsage,
            }) => {
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
            experimental_onToolCallStart: async (event) => {
              await attempt.append({
                type: "tool-execution-started",
                toolCallId: event.toolCall.toolCallId,
                toolName: event.toolCall.toolName,
                input: event.toolCall.input,
                ...(event.stepNumber === undefined ? {} : { stepNumber: event.stepNumber }),
              });
            },
            experimental_onToolCallFinish: async (event) => {
              await attemptLiveOutput.flush();
              const common = {
                type: "tool-execution-finished" as const,
                toolCallId: event.toolCall.toolCallId,
                toolName: event.toolCall.toolName,
                input: event.toolCall.input,
                durationMs: event.durationMs,
                ...(event.stepNumber === undefined ? {} : { stepNumber: event.stepNumber }),
              };
              await attempt.append(
                event.success
                  ? { ...common, result: { success: true, output: event.output } }
                  : { ...common, result: { success: false, errorText: errorText(event.error) } },
              );
            },
          },
        });

        const resultAttempt = await consumeModelAttempt(result, attempt);
        if (resultAttempt.kind === "finished") break;
        if (resultAttempt.kind === "aborted") {
          await attemptLiveOutput.flush();
          await attempt.flush();
          break;
        }
        failure = { error: resultAttempt.error, errorText: resultAttempt.errorText };
      } catch (error) {
        failure = { error, errorText: errorText(error) };
      }

      if (controller.signal.aborted) {
        await attemptLiveOutput.flush();
        await attempt.flush();
        break;
      }

      if (
        failure !== undefined &&
        !contextRecovered &&
        !attempt.hasContent &&
        request.recoverContext !== undefined &&
        isContextOverflowError(failure.error)
      ) {
        console.info("[agent][run] context overflow detected; attempting one recovery", {
          runId,
          ...summarizeModelError(failure.error),
        });
        let recoveredRequest: AgentModelRequest | undefined;
        try {
          recoveredRequest = await request.recoverContext(
            modelRequest,
            () =>
              prepareModelRequest({
                definition,
                request,
                input,
                signal: controller.signal,
                emitter: { toolOutput: attemptLiveOutput.emit },
              }),
            failure.error,
            controller.signal,
          );
        } catch (recoveryError) {
          console.warn("[agent][run] context recovery failed", {
            runId,
            ...summarizeModelError(recoveryError),
          });
        }
        if (recoveredRequest !== undefined && !controller.signal.aborted) {
          attempt.discard();
          contextRecovered = true;
          modelRequest = recoveredRequest;
          continue;
        }
        if (controller.signal.aborted) {
          await attemptLiveOutput.flush();
          await attempt.flush();
          break;
        }
      }

      await attemptLiveOutput.flush();
      await attempt.flush();
      await journal.append({
        type: "error",
        errorText: failure?.errorText ?? "模型流未提供终态",
      });
      if (failure) logRunFailed(runId, startedAt, failure.error);
      break;
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

export async function prepareModelRequest<Input>({
  definition,
  request,
  input,
  signal,
  emitter,
}: {
  definition: AgentDefinition<Input>;
  request: AgentRunRequest<Input, unknown>;
  input: Input;
  signal: AbortSignal;
  emitter: AgentToolOutputEmitter;
}): Promise<AgentModelRequest> {
  const modelRequest = await definition.prepare(input, signal, emitter);
  if (!request.prepareContext) return modelRequest;
  return request.prepareContext(
    modelRequest,
    () => definition.prepare(input, signal, emitter),
    signal,
  );
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
function createLiveToolOutputRelay(writer: { append(event: AgentEvent): Promise<void> }) {
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
        .then(() => writer.append({ type: "tool-output-delta", toolCallId, delta: chunk }))
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
