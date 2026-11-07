/** Interview Agent 定义：只组装面试提示词与 transcript 上下文，不处理 turn 生命周期。 */
import type { ModelMessage } from "ai";
import type { AgentDefinition } from "../core/agent/definition";
import { agentId } from "../core/agent/definition";
import type { ConversationStore } from "../core/transcript/store";
import { INTERVIEW_REPLY_PROFILE } from "./reply/profile";

export interface InterviewReplyInput {
  conversationId: string;
}

export function createInterviewReplyAgent(
  store: ConversationStore,
): AgentDefinition<InterviewReplyInput> {
  return {
    id: agentId("interview.reply"),
    modelRoute: "chat",
    async prepare({ conversationId }) {
      const snapshot = await store.load(conversationId);
      const messages: ModelMessage[] = snapshot.messages
        .filter((message) => message.status !== "streaming")
        .map((message) => ({ role: message.role, content: message.text }));
      return { system: INTERVIEW_REPLY_PROFILE.systemPrompt, messages };
    },
  };
}
