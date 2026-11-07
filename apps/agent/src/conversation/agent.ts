/** Conversation Agent 定义：组装对话 profile、transcript 上下文和授权工具。 */
import type { ConversationSendRequest } from "@answra/shared";
import { stepCountIs, type ToolSet } from "ai";
import type { AgentDefinition } from "../core/agent/definition";
import { agentId } from "../core/agent/definition";
import type { ConversationStore } from "../core/transcript/store";
import type { ChatProfile } from "./profiles/registry";
import type { ConversationToolId } from "./tools/types";
import { buildModelMessages } from "./turn/modelMessages";
import { buildWorkspaceSystemContext } from "./turn/workspaceContext";

export type ConversationAgentProfile = ChatProfile;

export interface ConversationAgentInput {
  conversationId: string;
  request: ConversationSendRequest;
  profile: ConversationAgentProfile;
  workspaceRoot: string | null;
}

export function createConversationAgentDefinition({
  store,
  createTools,
}: {
  store: ConversationStore;
  createTools: (
    ids: readonly ConversationToolId[],
    context: { workspaceRoot: string | null; signal: AbortSignal },
  ) => ToolSet | undefined;
}): AgentDefinition<ConversationAgentInput> {
  return {
    id: agentId("conversation.general"),
    modelRoute: "chat",
    async prepare(input, signal) {
      const messages = await buildModelMessages({
        conversationId: input.conversationId,
        request: input.request,
        includeHistory: input.profile.includeHistory,
        injectTime: input.profile.injectTime ?? false,
        store,
      });
      const tools =
        input.profile.tools.length === 0
          ? undefined
          : createTools(input.profile.tools, { workspaceRoot: input.workspaceRoot, signal });
      return {
        system: tools
          ? `${input.profile.systemPrompt}\n\n${buildWorkspaceSystemContext(input.workspaceRoot)}`
          : input.profile.systemPrompt,
        messages,
        ...(tools ? { tools, stopWhen: stepCountIs(6) } : {}),
      };
    },
  };
}
