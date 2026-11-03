import type { AgentStreamEvent } from "@answra/shared/schema";
import type { UIMessageChunk } from "ai";

/**
 * AI SDK 的流式 chunk 与产品事件的唯一转换点。
 * 只保留 UI 与 store 需要的稳定语义；provider metadata、step framing 与
 * 供应商特有字段不进入跨进程契约。
 */
export function normalizeStreamChunk(chunk: UIMessageChunk): AgentStreamEvent | undefined {
  switch (chunk.type) {
    case "start":
      return { type: "start" };
    case "text-start":
      return { type: "text-start", partId: chunk.id };
    case "text-end":
      return { type: "text-end", partId: chunk.id };
    case "text-delta":
      return { type: "text-delta", partId: chunk.id, delta: chunk.delta };
    case "reasoning-start":
      return { type: "reasoning-start", partId: chunk.id };
    case "reasoning-end":
      return { type: "reasoning-end", partId: chunk.id };
    case "reasoning-delta":
      return { type: "reasoning-delta", partId: chunk.id, delta: chunk.delta };
    case "tool-input-start":
      return {
        type: "tool-input-start",
        toolCallId: chunk.toolCallId,
        toolName: chunk.toolName,
        ...(chunk.title === undefined ? {} : { title: chunk.title }),
      };
    case "tool-input-delta":
      return {
        type: "tool-input-delta",
        toolCallId: chunk.toolCallId,
        delta: chunk.inputTextDelta,
      };
    case "tool-input-available":
      return {
        type: "tool-call",
        toolCallId: chunk.toolCallId,
        toolName: chunk.toolName,
        input: chunk.input,
      };
    case "tool-output-available":
      return {
        type: "tool-result",
        toolCallId: chunk.toolCallId,
        output: chunk.output,
      };
    case "tool-input-error":
    case "tool-output-error":
      return {
        type: "tool-error",
        toolCallId: chunk.toolCallId,
        errorText: chunk.errorText,
      };
    case "tool-output-denied":
      return {
        type: "tool-error",
        toolCallId: chunk.toolCallId,
        errorText: "工具调用被拒绝",
      };
    case "source-url":
      return {
        type: "source-url",
        sourceId: chunk.sourceId,
        url: chunk.url,
        ...(chunk.title === undefined ? {} : { title: chunk.title }),
      };
    case "source-document":
      return {
        type: "source-document",
        sourceId: chunk.sourceId,
        mediaType: chunk.mediaType,
        title: chunk.title,
      };
    case "error":
      return { type: "error", errorText: chunk.errorText };
    // Step framing, metadata and provider-only parts are intentionally not persisted.
    case "start-step":
    case "finish-step":
    case "finish":
    case "abort":
    case "message-metadata":
    case "file":
      return undefined;
    default:
      return undefined;
  }
}
