/**
 * AI SDK `TextStreamPart` 到 Agent 稳定事件的归一化边界。
 *
 * 这里只保留 provider-neutral 的模型事实，不创建 Conversation 消息、Execution
 * 状态或 UI 状态；provider metadata 和 raw chunk 不进入共享 schema。
 */
import type {
  AgentEvent,
  AgentExecutionEvent,
  AgentFinishReason,
  AgentStreamEvent,
} from "@answra/shared/schema";
import type { CallWarning, TextStreamPart, ToolSet } from "ai";

type FinishPart = Extract<TextStreamPart<ToolSet>, { type: "finish" }>;
type FinishStepPart = Extract<TextStreamPart<ToolSet>, { type: "finish-step" }>;
type SourcePart = Extract<TextStreamPart<ToolSet>, { type: "source" }>;

export interface StreamNormalizationContext {
  /** `fullStream` 的 step framing 没有重复携带 step number，消费器维护当前索引。 */
  stepIndex: number;
}

export function normalizeWarning(warning: CallWarning): AgentStreamEvent {
  switch (warning.type) {
    case "unsupported":
      return {
        type: "model-warning-unsupported",
        feature: warning.feature,
        ...(warning.details === undefined ? {} : { details: warning.details }),
      };
    case "compatibility":
      return {
        type: "model-warning-compatibility",
        feature: warning.feature,
        ...(warning.details === undefined ? {} : { details: warning.details }),
      };
    case "other":
      return { type: "model-warning-other", message: warning.message };
  }
}

export function normalizeStreamPart(
  part: TextStreamPart<ToolSet>,
  context: StreamNormalizationContext,
): AgentEvent | AgentEvent[] | undefined {
  switch (part.type) {
    case "start":
      return { type: "start" };
    case "finish":
      return {
        type: "finish",
        finishReason: normalizeFinishReason(part.finishReason),
        usage: normalizeUsage(part.totalUsage),
      };
    case "abort":
      return { type: "abort", ...(part.reason === undefined ? {} : { reason: part.reason }) };
    case "text-start":
      return { type: "text-start", partId: part.id };
    case "text-end":
      return { type: "text-end", partId: part.id };
    case "text-delta":
      return { type: "text-delta", partId: part.id, delta: part.text };
    case "reasoning-start":
      return { type: "reasoning-start", partId: part.id };
    case "reasoning-end":
      return { type: "reasoning-end", partId: part.id };
    case "reasoning-delta":
      return { type: "reasoning-delta", partId: part.id, delta: part.text };
    case "tool-input-start":
      return {
        type: "tool-input-start",
        toolCallId: part.id,
        toolName: part.toolName,
        ...(part.title === undefined ? {} : { title: part.title }),
      };
    case "tool-input-delta":
      return { type: "tool-input-delta", toolCallId: part.id, delta: part.delta };
    case "tool-input-end":
      return { type: "tool-input-end", toolCallId: part.id };
    case "tool-call":
      return {
        type: "tool-call",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
      };
    case "tool-result":
      return { type: "tool-result", toolCallId: part.toolCallId, output: part.output };
    case "tool-error":
      return { type: "tool-error", toolCallId: part.toolCallId, errorText: errorText(part.error) };
    case "tool-output-denied":
      return {
        type: "tool-output-denied",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
      };
    case "tool-approval-request":
      return {
        type: "tool-approval-request",
        approvalId: part.approvalId,
        toolCallId: part.toolCall.toolCallId,
        toolName: part.toolCall.toolName,
        input: part.toolCall.input,
        ...(part.signature === undefined ? {} : { signature: part.signature }),
      };
    case "source":
      return normalizeSource(part);
    case "file":
      return { type: "file", mediaType: part.file.mediaType, base64: part.file.base64 };
    case "start-step":
      return [stepStarted(context.stepIndex), ...part.warnings.map(normalizeWarning)];
    case "finish-step":
      return stepFinished(context.stepIndex, part);
    case "error":
      return { type: "error", errorText: errorText(part.error) };
    case "raw":
      return undefined;
    default:
      return undefined;
  }
}

function stepStarted(index: number): AgentExecutionEvent {
  return { type: "step-started", stepId: `step-${index}`, index };
}

function stepFinished(index: number, part: FinishStepPart): AgentExecutionEvent {
  const finishReason = normalizeFinishReason(part.finishReason);
  return {
    type: "step-finished",
    stepId: `step-${index}`,
    index,
    state: finishReason === "error" ? "failed" : "completed",
    finishReason,
    usage: normalizeUsage(part.usage),
  };
}

function normalizeSource(source: SourcePart): AgentStreamEvent {
  if (source.sourceType === "url") {
    return {
      type: "source-url",
      sourceId: source.id,
      url: source.url,
      ...(source.title === undefined ? {} : { title: source.title }),
    };
  }
  return {
    type: "source-document",
    sourceId: source.id,
    mediaType: source.mediaType,
    title: source.title,
  };
}

function normalizeFinishReason(reason: FinishPart["finishReason"]): AgentFinishReason {
  return reason;
}

function normalizeUsage(usage: FinishPart["totalUsage"] | FinishStepPart["usage"]) {
  const inputTokens = usage.inputTokens;
  const outputTokens = usage.outputTokens;
  const inputTokenDetails = usage.inputTokenDetails;
  const outputTokenDetails = usage.outputTokenDetails;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(inputTokens === undefined || outputTokens === undefined
      ? {}
      : { totalTokens: inputTokens + outputTokens }),
    ...(inputTokenDetails === undefined
      ? {}
      : {
          inputTokenDetails: {
            ...(inputTokenDetails.noCacheTokens === undefined
              ? {}
              : { noCacheTokens: inputTokenDetails.noCacheTokens }),
            ...(inputTokenDetails.cacheReadTokens === undefined
              ? {}
              : { cacheReadTokens: inputTokenDetails.cacheReadTokens }),
            ...(inputTokenDetails.cacheWriteTokens === undefined
              ? {}
              : { cacheWriteTokens: inputTokenDetails.cacheWriteTokens }),
          },
        }),
    ...(outputTokenDetails === undefined
      ? {}
      : {
          outputTokenDetails: {
            ...(outputTokenDetails.textTokens === undefined
              ? {}
              : { textTokens: outputTokenDetails.textTokens }),
            ...(outputTokenDetails.reasoningTokens === undefined
              ? {}
              : { reasoningTokens: outputTokenDetails.reasoningTokens }),
          },
        }),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "模型请求失败";
}
