/** CLI coding Agent 定义：组装独立 prompt、transcript 上下文和编码工具授权。 */
import type { ConversationSendRequest } from "@answra/shared";
import type { AgentDefinition, BotDiscovery, BotIdentity } from "../core/agent/definition";
import { agentId } from "../core/agent/definition";
import { createToolStepLimit } from "../core/agent/toolStepLimit";
import type { ReadFileStateMap, ToolRegistry } from "../core/tool";
import type { ConversationStore } from "../core/transcript/store";
import {
  buildCodingEnvironmentContext,
  buildCodingMessages,
  buildCodingWorkspaceContext,
} from "./context";
import type { CodingPolicy } from "./policy";

export const CODING_AGENT_ID = agentId("coding.engineer");

export const CODING_IDENTITY: BotIdentity = {
  name: "Coding 助手",
  role: "engineer",
  responsibility: "在命令行中读取、修改和验证工作区代码。",
  owns: ["coding", "workspace"],
};

export const CODING_DISCOVERY: BotDiscovery = {
  visibleTo: { kind: "bots", agentIds: [] },
};

export interface CodingAgentInput {
  conversationId: string;
  runId: string;
  request: ConversationSendRequest;
  policy: CodingPolicy;
  workspaceRoot: string | null;
  readFileState?: ReadFileStateMap;
}

export function createCodingAgentDefinition({
  store,
  tools,
}: {
  store: ConversationStore;
  tools: ToolRegistry;
}): AgentDefinition<CodingAgentInput> {
  return {
    id: CODING_AGENT_ID,
    identity: CODING_IDENTITY,
    discovery: CODING_DISCOVERY,
    modelRoute: "chat",
    async prepare(input, signal, emitter) {
      const messages = await buildCodingMessages({
        conversationId: input.conversationId,
        request: input.request,
        includeHistory: input.policy.includeHistory,
        store,
      });
      const toolSet =
        input.policy.tools.length === 0
          ? undefined
          : tools.authorize(input.policy.tools, {
              signal,
              workspaceRoot: input.workspaceRoot,
              runId: input.runId,
              sessionId: input.conversationId,
              ...(input.readFileState ? { readFileState: input.readFileState } : {}),
              ...(emitter ? { onToolOutput: emitter.toolOutput } : {}),
            });
      const system = toolSet
        ? [
            input.policy.systemPrompt,
            buildCodingEnvironmentContext(),
            buildCodingWorkspaceContext(input.workspaceRoot),
          ].join("\n\n")
        : input.policy.systemPrompt;
      return {
        system,
        messages,
        ...(toolSet ? { tools: toolSet, ...createToolStepLimit() } : {}),
      };
    },
  };
}
