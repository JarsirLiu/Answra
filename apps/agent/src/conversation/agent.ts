/** Conversation Agent 定义：组装对话 profile、transcript 上下文和授权工具集。 */
import type { ConversationSendRequest } from "@answra/shared";
import { stepCountIs } from "ai";
import type { AgentDefinition } from "../core/agent/definition";
import { agentId } from "../core/agent/definition";
import type { ReadFileStateMap, ToolRegistry } from "../core/tool";
import type { ConversationStore } from "../core/transcript/store";
import type { ChatProfile } from "./profiles/registry";
import { buildEnvironmentSystemContext, readRuntimeEnvironment } from "./turn/environmentContext";
import { buildModelMessages } from "./turn/modelMessages";
import { buildWorkspaceSystemContext } from "./turn/workspaceContext";

export type ConversationAgentProfile = ChatProfile;

export interface ConversationAgentInput {
  conversationId: string;
  runId: string;
  request: ConversationSendRequest;
  profile: ConversationAgentProfile;
  workspaceRoot: string | null;
  readFileState?: ReadFileStateMap;
}

export function createConversationAgentDefinition({
  store,
  tools,
}: {
  store: ConversationStore;
  tools: ToolRegistry;
}): AgentDefinition<ConversationAgentInput> {
  return {
    id: agentId("conversation.general"),
    modelRoute: "chat",
    async prepare(input, signal, emitter) {
      const messages = await buildModelMessages({
        conversationId: input.conversationId,
        request: input.request,
        includeHistory: input.profile.includeHistory,
        injectTime: input.profile.injectTime ?? false,
        store,
      });
      const toolSet =
        input.profile.tools.length === 0
          ? undefined
          : tools.authorize(input.profile.tools, {
              signal,
              workspaceRoot: input.workspaceRoot,
              runId: input.runId,
              sessionId: input.conversationId,
              ...(input.readFileState ? { readFileState: input.readFileState } : {}),
              ...(emitter ? { onToolOutput: emitter.toolOutput } : {}),
            });
      const system = toolSet
        ? [
            input.profile.systemPrompt,
            buildEnvironmentSystemContext(readRuntimeEnvironment()),
            buildWorkspaceSystemContext(input.workspaceRoot),
          ].join("\n\n")
        : input.profile.systemPrompt;
      return {
        system,
        messages,
        ...(toolSet ? { tools: toolSet, stopWhen: stepCountIs(6) } : {}),
      };
    },
  };
}
