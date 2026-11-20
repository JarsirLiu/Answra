/** 把保留用户消息与最近检查点摘要注入模型上下文；摘要始终是 synthetic user message。 */
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
  const retained = checkpoint.retainedUserMessages ?? [];
  return [
    ...project(retained),
    {
      role: "user",
      content: [{ type: "text", text: summaryMessageText(checkpoint.summary) }],
    },
    ...project(tail),
  ];
}

function summaryMessageText(summary: string): string {
  return `以下是之前会话的摘要。基于摘要继续，不要重复已完成的工作；尤其不要重做已完成的写文件、提交、发消息或运行命令等有副作用的操作，需要时先做只读验证，不要臆测摘要未包含的细节。\n\n${summary}`;
}
