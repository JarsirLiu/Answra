/** 单次 provider 请求的 StepRunner：准备上下文、消费模型流、写 step 级模型事件；不写 step-* 或 Turn 状态。 */
import type { ConversationCapabilityEndpoint } from "@answra/shared";
import type { AgentFinishReason, AgentStreamEvent, AgentUsage } from "@answra/shared/schema";
import type { TextStreamPart, ToolSet } from "ai";
import type { StepContextManager } from "../context/stepContextManager";
import { isContextOverflowError } from "../model/contextOverflow";
import {
  type ModelStreamOptions,
  type ModelTransportOptions,
  streamModel,
} from "../model/modelTransport";
import type { RetryAttempt } from "../model/retryFetch";
import { createStreamPartIdScope } from "../model/streamEvents";
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
import { modelToolSet } from "./modelToolSet";
import { executeModelToolCalls, type ModelToolCall } from "./toolCallExecutor";

type StepModelStream = (input: {
  transport: ModelTransportOptions;
  options: ModelStreamOptions;
  signal: AbortSignal;
}) => AsyncIterable<TextStreamPart<ToolSet>>;

export interface ProviderStepRunnerOptions {
  /** 固定端点（测试与单端点宿主）；与 getEndpoint 二选一。 */
  endpoint?: ConversationCapabilityEndpoint;
  /** 延迟解析当前模型端点，供启动后才收到 configure 的宿主使用。 */
  getEndpoint?: () => ConversationCapabilityEndpoint;
  prepare: (
    step: StepStart,
    signal: AbortSignal,
    emitter: AgentToolOutputEmitter,
  ) => Promise<AgentModelRequest>;
  contextManager?: StepContextManager;
  resolveHandoff?: (step: StepStart) => Promise<TurnHandoff | undefined>;
  tokenProvider?: (options: { forceRefresh: boolean }) => Promise<string>;
  stream?: StepModelStream;
  /**
   * 每次 provider 请求结束时报告这次请求的输入量。
   */
  onRequestFinished?: (event: { sessionId: string; inputTokens: number }) => void | Promise<void>;
}

/** 单次模型请求；工具执行由项目在模型响应后完成。 */
export class ProviderStepRunner implements StepRunner {
  private readonly getEndpoint: () => ConversationCapabilityEndpoint;
  private readonly prepareRequest: ProviderStepRunnerOptions["prepare"];
  private readonly contextManager?: StepContextManager;
  private readonly resolveHandoff?: ProviderStepRunnerOptions["resolveHandoff"];
  private readonly tokenProvider?: ProviderStepRunnerOptions["tokenProvider"];
  private readonly stream: StepModelStream;
  private readonly onRequestFinished?: ProviderStepRunnerOptions["onRequestFinished"];

  constructor({
    endpoint,
    getEndpoint,
    prepare,
    contextManager,
    resolveHandoff,
    tokenProvider,
    stream = streamModel,
    onRequestFinished,
  }: ProviderStepRunnerOptions) {
    if (endpoint === undefined && getEndpoint === undefined)
      throw new Error("ProviderStepRunner 缺少模型端点");
    this.getEndpoint = getEndpoint ?? (() => endpoint as ConversationCapabilityEndpoint);
    this.prepareRequest = prepare;
    this.contextManager = contextManager;
    this.resolveHandoff = resolveHandoff;
    this.tokenProvider = tokenProvider;
    this.stream = stream;
    this.onRequestFinished = onRequestFinished;
  }

  async run(
    step: StepStart,
    context: StepRunContext,
    signal: AbortSignal,
  ): Promise<StepRunnerResult> {
    if (signal.aborted) return { outcome: "aborted" };

    const liveOutput = createLiveToolOutputRelay(context.events);
    const emitter: AgentToolOutputEmitter = { toolOutput: liveOutput.emit };
    const prepareModelRequest = async (): Promise<AgentModelRequest> =>
      prepareForStep(await this.prepareRequest(step, signal, emitter), step.index);
    let modelRequest = await prepareModelRequest();
    if (this.contextManager !== undefined) {
      modelRequest = await this.contextManager.prepare({
        conversationId: step.sessionId,
        getAccessToken: context.runtime.getAccessToken,
        modelRequest,
        rebuild: prepareModelRequest,
        signal,
      });
    }
    if (signal.aborted) return { outcome: "aborted" };

    const accessToken = await context.runtime.getAccessToken();
    // 每次项目 Step 只有一次 streamModel 调用；provider 的传输层重试仍由 ModelTransport 管理。
    const scopePartId = createStreamPartIdScope(step.stepId);

    let finished: { finishReason: AgentFinishReason; usage?: AgentUsage } | undefined;
    const requestTokens: { firstInputTokens?: number } = {};
    const toolCalls: ModelToolCall[] = [];
    const attempt = createModelAttemptSink({
      append: async (event) => {
        const streamEvent = asModelStreamEvent(event);
        if (streamEvent === undefined) return;
        if (streamEvent.type === "tool-call") {
          toolCalls.push({
            toolCallId: streamEvent.toolCallId,
            toolName: streamEvent.toolName,
            input: streamEvent.input,
          });
        }
        if (streamEvent.type === "finish") {
          finished = {
            finishReason: streamEvent.finishReason,
            ...(streamEvent.usage === undefined ? {} : { usage: streamEvent.usage }),
          };
        }
        await context.events.append(scopePartId(streamEvent));
      },
    });
    const transport: ModelTransportOptions = {
      endpoint: this.getEndpoint(),
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
            tools: modelToolSet(modelRequest.tools),
            prepareStep: undefined,
            onStepFinish: async (event) => {
              const inputTokens = event.usage?.inputTokens;
              if (inputTokens === undefined) return;
              requestTokens.firstInputTokens ??= inputTokens;
              await this.onRequestFinished?.({ sessionId: step.sessionId, inputTokens });
            },
          },
        }),
        attempt,
      );
      if (result.kind === "finished") {
        await flush(liveOutput, attempt);
        if (finished?.finishReason === "tool-calls") {
          const toolOutcome = await executeModelToolCalls({
            tools: modelRequest.tools,
            calls: toolCalls,
            messages: modelRequest.messages,
            signal,
            events: context.events,
            flushOutput: liveOutput.flush,
          });
          if (toolOutcome === "aborted") return { outcome: "aborted" };
        }
        return this.finish(step, finished, requestTokens);
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
      !attempt.hasContent &&
      this.contextManager !== undefined &&
      isContextOverflowError(failure.error)
    ) {
      try {
        const recovered = await this.contextManager.recover({
          conversationId: step.sessionId,
          getAccessToken: context.runtime.getAccessToken,
          modelRequest,
          rebuild: prepareModelRequest,
          signal,
        });
        if (recovered !== undefined && !signal.aborted) {
          attempt.discard();
          return { outcome: "completed", continuation: "context-recovered" };
        }
      } catch (recoveryError) {
        failure = {
          error: recoveryError,
          errorText: `上下文压缩恢复失败：${errorText(recoveryError)}`,
        };
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

  private async finish(
    step: StepStart,
    finished: { finishReason: AgentFinishReason; usage?: AgentUsage } | undefined,
    requestTokens: { firstInputTokens?: number },
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
      ...(requestTokens.firstInputTokens === undefined
        ? {}
        : { requestTokens: { firstInputTokens: requestTokens.firstInputTokens } }),
      ...(handoff === undefined ? {} : { handoff }),
    };
  }
}

function retryEvent(retry: RetryAttempt): AgentStreamEvent {
  return { type: "retry", ...retry };
}

async function prepareForStep(
  request: AgentModelRequest,
  stepNumber: number,
): Promise<AgentModelRequest> {
  const policy = await request.prepareStep?.({ stepNumber, messages: request.messages });
  if (policy === undefined) return request;
  return { ...request, ...policy };
}

async function flush(
  liveOutput: { flush(): Promise<void> },
  attempt: { flush(): Promise<void> },
): Promise<void> {
  await liveOutput.flush();
  await attempt.flush();
}

/** AI SDK 内部的 step framing 属于 provider 流，不进入 Session 的 step-*；SessionStepExecutor 独占这些事件。 */
function asModelStreamEvent(event: AgentStreamEvent): AgentStreamEvent | undefined {
  return event;
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "工具执行失败";
}
