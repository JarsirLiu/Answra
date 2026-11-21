/** 把 transcript 渲染成摘要模型可读的正文；思考不进入摘要，已清理工具结果只保留占位符。 */
import type { ConversationMessage, ConversationMessagePart } from "@answra/shared";
import { PRUNED_TOOL_RESULT_TEXT } from "../pruning/clearedResult";

type ToolPart = Extract<ConversationMessagePart, { kind: "tool" }>;

interface RenderedMessage {
  heading: string;
  body: string[];
  tools: string[];
}

export function renderMessagesForSummary({
  messages,
  prunedToolCallIds,
}: {
  messages: readonly ConversationMessage[];
  prunedToolCallIds: ReadonlySet<string>;
}): string {
  return messages
    .map((message) => renderMessage(message, prunedToolCallIds))
    .filter(hasContent)
    .map((message) => [message.heading, ...message.body, ...message.tools].join("\n"))
    .join("\n\n");
}

/** 摘要请求超限时丢弃最旧的一条消息；只剩一条时返回 undefined。 */
export function dropOldestSummaryMessage(
  messages: readonly ConversationMessage[],
): ConversationMessage[] | undefined {
  return messages.length <= 1 ? undefined : messages.slice(1);
}

function renderMessage(
  message: ConversationMessage,
  prunedToolCallIds: ReadonlySet<string>,
): RenderedMessage {
  const heading =
    message.role === "user"
      ? "### 用户"
      : `### 助手${message.authorAgentId ? `（${message.authorAgentId}）` : ""}`;
  const audiences = message.audience?.kind === "bot" ? `（发给 ${message.audience.agentId}）` : "";
  const body: string[] = [];
  if (message.text) body.push(message.text);
  for (const image of message.images) body.push(renderImage(image));
  const tools = (message.parts ?? [])
    .filter((part): part is ToolPart => part.kind === "tool")
    .map((part) => renderToolPart(part, prunedToolCallIds));
  return { heading: heading + audiences, body, tools };
}

function hasContent(message: RenderedMessage): boolean {
  return message.body.length > 0 || message.tools.length > 0;
}

function renderImage(image: { name: string; dataUrl: string }): string {
  const mediaType = /^data:([^;,]+)[;,]/.exec(image.dataUrl)?.[1];
  return mediaType ? `[图片：${image.name}（${mediaType}）]` : `[图片：${image.name}]`;
}

function renderToolPart(part: ToolPart, prunedToolCallIds: ReadonlySet<string>): string {
  const lines = [`[工具调用 ${part.toolName}]`];
  const input = toolInputText(part);
  if (input) lines.push(`输入: ${input}`);
  if (prunedToolCallIds.has(part.toolCallId)) {
    lines.push(`[工具结果] ${PRUNED_TOOL_RESULT_TEXT}`);
    return lines.join("\n");
  }
  const result = toolResultText(part);
  if (result) lines.push(`[工具结果] ${result}`);
  return lines.join("\n");
}

function toolInputText(part: ToolPart): string {
  const input = part.input ?? part.inputText;
  return input === undefined ? "" : stringifyToolValue(input);
}

function toolResultText(part: ToolPart): string {
  switch (part.state) {
    case "completed":
      return part.output === undefined ? "[无输出]" : stringifyToolValue(part.output);
    case "failed":
      return `错误: ${part.errorText ?? "工具执行失败。"}`;
    case "denied":
      return "工具调用被拒绝，没有返回结果。";
    case "interrupted":
      return "工具执行被中断，没有返回结果。";
    default:
      return "工具调用未完成，没有返回结果。";
  }
}

function stringifyToolValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
