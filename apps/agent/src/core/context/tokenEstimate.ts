/** 上下文预算的保守 token 估算；不调用模型，也不依赖 provider 分词器。 */

import type { ConversationMessage } from "@answra/shared";
import type { ModelMessage, ToolResultPart, ToolSet } from "ai";
import type { ContextUsageAnchor } from "../transcript/contextState";
import type { ContextModelRequest } from "./budget";

const ASCII_CHARS_PER_TOKEN = 4;
const IMAGE_TOKEN_ESTIMATE = 2_000;
const FILE_TOKEN_ESTIMATE = 2_000;

/** 估算一段文本的 token 数；CJK 字符按 1 token、其余按 4 字符/token 保守折算。 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let cjkCount = 0;
  for (const char of text) {
    if (isCjk(char.codePointAt(0) ?? 0)) cjkCount += 1;
  }
  return cjkCount + Math.ceil((text.length - cjkCount) / ASCII_CHARS_PER_TOKEN);
}

/** 估算单条 transcript 消息进入模型后的 token 数；有 parts 时不再重复计算 text。 */
export function estimateMessageTokens(message: ConversationMessage): number {
  let tokens = message.images.length * IMAGE_TOKEN_ESTIMATE;
  if (message.parts && message.parts.length > 0) {
    for (const part of message.parts) {
      if (part.kind === "tool") {
        if (part.input !== undefined) {
          tokens += estimateTextTokens(part.toolName);
          tokens += estimateTextTokens(stringifyValue(part.input));
          tokens += estimateToolResultTokens(part);
        }
        continue;
      }
      tokens += estimateTextTokens(part.text);
    }
    return tokens;
  }
  return tokens + estimateTextTokens(message.text);
}

export function estimateMessagesTokens(messages: readonly ConversationMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

/** 估算最终模型请求；system 与 tools 只在这里计入一次，不再加固定开销。 */
export function estimateContextRequestTokens(request: ContextModelRequest): number {
  return (
    estimateTextTokens(request.system) +
    request.messages.reduce((total, message) => total + estimateModelMessageTokens(message), 0) +
    (request.tools ? estimateToolsTokens(request.tools) : 0)
  );
}

/**
 * 用上一轮成功 run 的实际/估算比例校准当前估算。
 * 锚点缺失或数值无效时回退保守估算；锚点只用于发送前的阈值判断。
 */
export function calibrateContextTokens(
  estimatedTokens: number,
  anchor: ContextUsageAnchor | undefined,
): number {
  if (!anchor || estimatedTokens <= 0 || anchor.inputTokens <= 0 || anchor.estimatedTokens <= 0) {
    return estimatedTokens;
  }
  return Math.max(1, Math.round((estimatedTokens * anchor.inputTokens) / anchor.estimatedTokens));
}

function estimateModelMessageTokens(message: ModelMessage): number {
  if (typeof message.content === "string") return estimateTextTokens(message.content);
  return message.content.reduce((total, part) => total + estimateModelPartTokens(part), 0);
}

function estimateModelPartTokens(part: Exclude<ModelMessage["content"], string>[number]): number {
  switch (part.type) {
    case "text":
      return estimateTextTokens(part.text);
    case "image":
      return IMAGE_TOKEN_ESTIMATE;
    case "file":
      return (
        FILE_TOKEN_ESTIMATE +
        estimateTextTokens(part.filename ?? "") +
        estimateTextTokens(part.mediaType)
      );
    case "reasoning":
      return estimateTextTokens(part.text);
    case "tool-call":
      return estimateTextTokens(part.toolName) + estimateTextTokens(stringifyValue(part.input));
    case "tool-result":
      return estimateTextTokens(part.toolName) + estimateToolResultOutputTokens(part.output);
    case "tool-approval-request":
      return (
        estimateTextTokens(part.approvalId) +
        estimateTextTokens(stringifyValue(part.inputSchemaInput))
      );
    case "tool-approval-response":
      return estimateTextTokens(part.approvalId) + estimateTextTokens(part.reason ?? "");
  }
}

function estimateToolsTokens(tools: ToolSet): number {
  let total = 0;
  for (const [name, tool] of Object.entries(tools)) {
    total += estimateTextTokens(name);
    total += estimateTextTokens(tool.title ?? "");
    total += estimateTextTokens(tool.description ?? "");
    total += estimateTextTokens(stringifyValue(tool.inputSchema));
    total += estimateTextTokens(stringifyValue(tool.inputExamples));
  }
  return total;
}

function estimateToolResultTokens(
  part: Extract<NonNullable<ConversationMessage["parts"]>[number], { kind: "tool" }>,
): number {
  switch (part.state) {
    case "completed":
      return estimateTextTokens(stringifyValue(part.output));
    case "failed":
      return estimateTextTokens(part.errorText ?? "工具执行失败。");
    case "denied":
      return estimateTextTokens("工具调用被拒绝，没有返回结果。");
    case "interrupted":
      return estimateTextTokens("工具执行被中断，没有返回结果。");
    default:
      return estimateTextTokens("工具调用未完成，没有返回结果。");
  }
}

function estimateToolResultOutputTokens(output: ToolResultPart["output"]): number {
  switch (output.type) {
    case "text":
    case "error-text":
      return estimateTextTokens(output.value);
    case "json":
    case "error-json":
      return estimateTextTokens(stringifyValue(output.value));
    case "execution-denied":
      return estimateTextTokens(output.reason ?? "");
    case "content":
      return output.value.reduce((total, part) => {
        switch (part.type) {
          case "text":
            return total + estimateTextTokens(part.text);
          case "media":
          case "file-data":
          case "image-data":
            return total + FILE_TOKEN_ESTIMATE + estimateTextTokens(part.mediaType);
          case "file-url":
            return total + estimateTextTokens(part.url) + estimateTextTokens(part.mediaType ?? "");
          case "image-url":
            return total + estimateTextTokens(part.url);
          case "file-id":
          case "image-file-id":
            return total + estimateTextTokens(stringifyValue(part.fileId));
          case "custom":
            return total;
          default:
            return total;
        }
      }, 0);
  }
}

function isCjk(codePoint: number): boolean {
  return (
    (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff)
  );
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}
