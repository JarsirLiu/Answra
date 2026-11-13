/** 把 transcript 渲染成摘要模型可读的正文；思考与工具细节不进入摘要输入。 */
import type { ConversationMessage } from "@answra/shared";

export function renderMessagesForSummary(messages: readonly ConversationMessage[]): string {
  return messages
    .map((message) => renderMessage(message))
    .filter((text) => text.length > 0)
    .join("\n\n");
}

function renderMessage(message: ConversationMessage): string {
  const body = message.text;
  if (!body) return "";
  const heading =
    message.role === "user"
      ? "### 用户"
      : `### 助手${message.authorAgentId ? `（${message.authorAgentId}）` : ""}`;
  const audiences = message.audience?.kind === "bot" ? `（发给 ${message.audience.agentId}）` : "";
  return [heading + audiences, body].join("\n");
}
