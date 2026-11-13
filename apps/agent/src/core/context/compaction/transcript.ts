/** 把 transcript 渲染成摘要模型可读的纯文本；不依赖具体领域。 */
import type { ConversationMessage, ConversationMessagePart } from "@answra/shared";

export function renderMessagesForSummary(messages: readonly ConversationMessage[]): string {
  return messages
    .map((message) => renderMessage(message))
    .filter((text) => text.length > 0)
    .join("\n\n");
}

function renderMessage(message: ConversationMessage): string {
  const heading =
    message.role === "user"
      ? "### 用户"
      : `### 助手${message.authorAgentId ? `（${message.authorAgentId}）` : ""}`;
  const body = message.parts?.length
    ? message.parts.map(renderPart).filter(Boolean).join("\n")
    : message.text;
  const audiences = message.audience?.kind === "bot" ? `（发给 ${message.audience.agentId}）` : "";
  return [heading + audiences, body].filter(Boolean).join("\n");
}

function renderPart(part: ConversationMessagePart): string {
  if (part.kind === "text" || part.kind === "reasoning") return part.text;
  return [
    `工具调用 ${part.toolName}（${part.state}）`,
    part.input === undefined ? "" : `输入：${stringify(part.input)}`,
    part.output === undefined ? "" : `输出：${stringify(part.output)}`,
    part.errorText ? `错误：${part.errorText}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
