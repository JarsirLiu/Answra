/** 把 transcript 渲染成摘要模型可读的正文；思考与工具细节不进入摘要输入。 */
import type { ConversationMessage } from "@answra/shared";

export function renderMessagesForSummary(messages: readonly ConversationMessage[]): string {
  return messages
    .map((message) => renderMessage(message))
    .filter((text) => text.length > 0)
    .join("\n\n");
}

/** 摘要请求超限时丢弃最旧的一轮用户回合；只有一轮时返回 undefined。 */
export function dropOldestSummaryTurn(
  messages: readonly ConversationMessage[],
): ConversationMessage[] | undefined {
  const firstUser = messages.findIndex((message) => message.role === "user");
  if (firstUser < 0) return messages.length > 1 ? messages.slice(1) : undefined;
  const nextUser = messages.findIndex(
    (message, index) => index > firstUser && message.role === "user",
  );
  return nextUser < 0 ? undefined : messages.slice(nextUser);
}

function renderMessage(message: ConversationMessage): string {
  const heading =
    message.role === "user"
      ? "### 用户"
      : `### 助手${message.authorAgentId ? `（${message.authorAgentId}）` : ""}`;
  const audiences = message.audience?.kind === "bot" ? `（发给 ${message.audience.agentId}）` : "";
  const lines = [heading + audiences];
  if (message.text) lines.push(message.text);
  for (const image of message.images) lines.push(renderImage(image));
  return lines.length > 1 ? lines.join("\n") : "";
}

function renderImage(image: { name: string; dataUrl: string }): string {
  const mediaType = /^data:([^;,]+)[;,]/.exec(image.dataUrl)?.[1];
  return mediaType ? `[图片：${image.name}（${mediaType}）]` : `[图片：${image.name}]`;
}
