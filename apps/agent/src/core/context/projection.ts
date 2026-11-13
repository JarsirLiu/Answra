/** 把最近检查点摘要注入模型上下文；摘要始终是 synthetic user message。 */
import type { ConversationMessage } from "@answra/shared";
import type { ModelMessage } from "ai";
import { type ContextCheckpoint, messagesAfterCheckpoint } from "../transcript/contextCheckpoint";

export function projectContextMessages({
  messages,
  checkpoint,
  project,
}: {
  messages: readonly ConversationMessage[];
  checkpoint: ContextCheckpoint | undefined;
  project: (messages: readonly ConversationMessage[]) => ModelMessage[];
}): ModelMessage[] {
  const tail = messagesAfterCheckpoint(messages, checkpoint);
  if (!tail) return project(messages);
  if (!checkpoint) return project(tail);
  return [
    {
      role: "user",
      content: [{ type: "text", text: summaryMessageText(checkpoint.summary) }],
    },
    ...project(tail),
  ];
}

function summaryMessageText(summary: string): string {
  return `以下内容是对更早会话的摘要，作为当前对话的既有上下文：\n\n${summary}`;
}
