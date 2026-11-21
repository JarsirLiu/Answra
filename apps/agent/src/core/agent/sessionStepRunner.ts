/** 单次 provider 请求的 StepRunner：准备上下文、消费模型流、写 step 级模型事件；不写 step-* 或 Turn 状态。 */
import type { ConversationCapabilityEndpoint } from "@answra/shared";
import type {
  AgentEvent,
  AgentFinishReason,
  AgentStreamEvent,
  AgentUsage,
} from "@answra/shared/schema";
import type { TextStreamPart, ToolSet } from "ai";
import type { StepContextManager } from "../context/stepContextManager";
import { isContextOverflowError } from "../model/contextOverflow";
import {
  type ModelStreamOptions,
  type ModelTransportOptions,
  streamModel,
} from "../model/modelTransport";
import type { RetryAttempt } from "../model/retryFetch";
import type {
  StepRunContext,
  StepRunner,
  StepRunnerResult,
  StepStart,
  TurnHandoff,
} from "../session/contracts";
import type { AgentModelRequest, AgentToolOutputEmitter } from "./definition";
import { createLiveToolOutputRelay } from "./liveToolOutput";
import { consumeModelAttempt, createModelAttemptSink } from "./modelAttempt";

type StepModelStream = (input: {
  transport: ModelTransportOptions;
  options: ModelStreamOptions;
  signal: AbortSignal;
}) => AsyncIterable<TextStreamPart<ToolSet>>;

export interface SessionStepRunnerOptions {
  endpoint: ConversationCapabilityEndpoint;
  getAccessToken: () => Promise<string>;
  prepare: (
    step: StepStart,
    signal: AbortSignal,
    emitter: AgentToolOutputEmitter,
  ) => Promise<AgentModelRequest>;
  contextManager?: StepContextManager;
  resolveHandoff?: (step: StepStart) => Promise<TurnHandoff | undefined>;
  tokenProvider?: (options: { forceRefresh: boolean }) => Promise<string>;
  stream?: StepModelStream;
}

/** 单次模型请求；同一 Step 内的工具执行仍由 AI SDK 负责。 */
export class SessionStepRunner implements StepRunner {
  private readonly endpoint: ConversationCapabilityEndpoint;
  private readonly getAccessToken: () => Promise<string>;
  private readonly prepareRequest: SessionStepRunnerOptions["prepare"];
  private readonly contextManager?: StepContextManager;
  private readonly resolveHandoff?: SessionStepRunnerOptions["resolveHandoff"];
  private readonly tokenProvider?: SessionStepRunnerOptions["tokenProvider"];
  private readonly stream: StepModelStream;

  constructor({
    endpoint,
    getAccessToken,
    prepare,
    contextManager,
    resolveHandoff,
    tokenProvider,
    stream = streamModel,
  }: SessionStepRunnerOptions) {
    this.endpoint = endpoint;
    this.getAccessToken = getAccessToken;
    this.prepareRequest = prepare;
    this.contextManager = contextManager;
    this.resolveHandoff = resolveHandoff;
    this.tokenProvider = tokenProvider;
    this.stream = stream;
  }

  async run(
    step: StepStart,
    context: StepRunContext,
    signal: AbortSignal,
  ): Promise<StepRunnerResult> {
    if (signal.aborted) return { outcome: "aborted" };

    const liveOutput = createLiveToolOutputRelay(context.events);
    const emitter: AgentToolOutputEmitter = { toolOutput: liveOutput.emit };
    let modelRequest = await this.prepareRequest(step, signal, emitter);
    if (this.contextManager !== undefined) {
      modelRequest = await this.contextManager.prepare({
        conversationId: step.sessionId,
        getAccessToken: this.getAccessToken,
        modelRequest,
        rebuild: () => this.prepareRequest(step, signal, emitter),
        signal,
      });
    }
    if (signal.aborted) return { outcome: "aborted" };

    const accessToken = await this.getAccessToken();
    let contextRecovered = false;

    for (;;) {
      let finished: { finishReason: AgentFinishReason; usage?: AgentUsage } | undefined;
      const attempt = createModelAttemptSink({
        append: async (event) => {
          const streamEvent = asModelStreamEvent(event);
          if (streamEvent === undefined) return;
          if (streamEvent.type === "finish") {
            finished = {
              finishReason: streamEvent.finishReason,
              ...(streamEvent.usage === undefined ? {} : { usage: streamEvent.usage }),
            };
          }
          await context.events.append(streamEvent);
        },
      });
      const transport: ModelTransportOptions = {
        endpoint: this.endpoint,
        accessToken,
        conversationId: step.sessionId,
        runId: step.stepId,
        ...(this.tokenProvider === undefined ? {} : { tokenProvider: this.tokenProvider }),
        onRetry: (retry) => context.events.append(retryEvent(retry)),
      };

      let failure: { error: unknown; errorText: string } | undefined;
      try {
        const result = await consumeModelAttempt(
          this.stream({
            transport,
            signal,
            options: {
              ...modelRequest,
              experimental_onToolCallStart: async (event) => {
                await context.events.append({
                  type: "tool-execution-started",
                  toolCallId: event.toolCall.toolCallId,
                  toolName: event.toolCall.toolName,
                  input: event.toolCall.input,
                  ...(event.stepNumber === undefined ? {} : { stepNumber: event.stepNumber }),
                });
              },
              experimental_onToolCallFinish: async (event) => {
                await liveOutput.flush();
                const common = {
                  type: "tool-execution-finished" as const,
                  toolCallId: event.toolCall.toolCallId,
                  toolName: event.toolCall.toolName,
                  input: event.toolCall.input,
                  durationMs: event.durationMs,
                  ...(event.stepNumber === undefined ? {} : { stepNumber: event.stepNumber }),
                };
                await context.events.append(
                  event.success
                    ? { ...common, result: { success: true, output: event.output } }
                    : { ...common, result: { success: false, errorText: errorText(event.error) } },
                );
              },
            },
          }),
          attempt,
        );
        if (result.kind === "finished") {
          await flush(liveOutput, attempt);
          return this.finish(step, finished);
        }
        if (result.kind === "aborted") {
          await flush(liveOutput, attempt);
          return { outcome: "aborted" };
        }
        failure = { error: result.error, errorText: result.errorText };
      } catch (error) {
        failure = { error, errorText: errorText(error) };
      }

      if (signal.aborted) {
        await flush(liveOutput, attempt);
        return { outcome: "aborted" };
      }
      if (
        failure !== undefined &&
        !contextRecovered &&
        !attempt.hasContent &&
        this.contextManager !== undefined &&
        isContextOverflowError(failure.error)
      ) {
        const recovered = await this.contextManager
          .recover({
            conversationId: step.sessionId,
            getAccessToken: this.getAccessToken,
            modelRequest,
            rebuild: () => this.prepareRequest(step, signal, emitter),
            signal,
          })
          .catch(() => undefined);
        if (recovered !== undefined && !signal.aborted) {
          attempt.discard();
          modelRequest = recovered;
          contextRecovered = true;
          continue;
        }
      }
      if (signal.aborted) {
        await flush(liveOutput, attempt);
        return { outcome: "aborted" };
      }

      await flush(liveOutput, attempt);
      await context.events.append({
        type: "error",
        errorText: failure?.errorText ?? "模型流未提供终态",
      });
      return { outcome: "failed", errorText: failure?.errorText ?? "模型流未提供终态" };
    }
  }

  private async finish(
    step: StepStart,
    finished: { finishReason: AgentFinishReason; usage?: AgentUsage } | undefined,
  ): Promise<StepRunnerResult> {
    if (finished === undefined) {
      return { outcome: "failed", errorText: "模型流未提供终态" };
    }
    if (finished.finishReason === "error") {
      return { outcome: "failed", finishReason: "error", errorText: "模型返回错误" };
    }
    const handoff =
      this.resolveHandoff === undefined || finished.finishReason === "tool-calls"
        ? undefined
        : await this.resolveHandoff(step);
    return {
      outcome: "completed",
      finishReason: finished.finishReason,
      ...(finished.usage === undefined ? {} : { usage: finished.usage }),
      ...(handoff === undefined ? {} : { handoff }),
    };
  }
}

function retryEvent(retry: RetryAttempt): AgentStreamEvent {
  return { type: "retry", ...retry };
}

async function flush(
  liveOutput: { flush(): Promise<void> },
  attempt: { flush(): Promise<void> },
): Promise<void> {
  await liveOutput.flush();
  await attempt.flush();
}

/** AI SDK 内部的 step framing 属于 provider 流，不进入 Session 的 step-*；SessionStepExecutor 独占这些事件。 */
function asModelStreamEvent(event: AgentEvent): AgentStreamEvent | undefined {
  if (
    event.type === "step-started" ||
    event.type === "step-finished" ||
    event.type === "context-usage-changed"
  ) {
    return undefined;
  }
  return event as AgentStreamEvent;
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "工具执行失败";
}
