/**
 * AI SDK 模型流的归一化边界。
 *
 * 文件职责：接收 AI SDK 的 `UIMessageChunk`，输出共享 schema 定义的
 * `AgentStreamEvent`，让 Conversation 生成领域不直接依赖供应商流字段。
 * 这里只处理模型流语义，不创建 Conversation 消息、Execution 状态或 UI 状态。
 * provider metadata、step framing 和供应商特有字段不会进入稳定事件。
 */
import type { AgentStreamEvent } from "@answra/shared/schema";
import type { UIMessageChunk } from "ai";

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
