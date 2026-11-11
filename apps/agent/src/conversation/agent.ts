/** Conversation Agent 定义：组装对话 profile、transcript 上下文和授权工具集。 */
import type { ConversationSendRequest } from "@answra/shared";
import type {
  AgentDefinition,
  AgentId,
  BotDiscovery,
  BotIdentity,
  BotTurnResult,
} from "../core/agent/definition";
import { agentId } from "../core/agent/definition";
import { createToolStepLimit } from "../core/agent/toolStepLimit";
import type { ReadFileStateMap, ToolRegistry } from "../core/tool";
import type { ConversationStore } from "../core/transcript/store";
import { CHAT_PROFILES, type ChatProfile } from "./profiles/registry";
import { buildEnvironmentSystemContext, readRuntimeEnvironment } from "./turn/environmentContext";
import { buildModelMessages } from "./turn/modelMessages";
import { buildWorkspaceSystemContext } from "./turn/workspaceContext";

export type ConversationAgentProfile = ChatProfile;

export const CONVERSATION_TEAM_ID = "conversation";
export const CONVERSATION_AGENT_ID = agentId("conversation.general");

export const GENERAL_IDENTITY: BotIdentity = {
  name: "通用助手",
  role: "general",
  responsibility: "处理通用对话、文件读写、检索与代码修改。",
  owns: ["conversation"],
};

export const GENERAL_DISCOVERY: BotDiscovery = {
  visibleTo: { kind: "team", teamId: CONVERSATION_TEAM_ID },
};

export interface ConversationAgentInput {
  conversationId: string;
  runId: string;
  request: ConversationSendRequest;
  profile: ConversationAgentProfile;
  workspaceRoot: string | null;
  readFileState?: ReadFileStateMap;
  /** 当前发言 Bot；用于按 author/audience 投影历史和交接消息。 */
  viewerAgentId?: string;
  /** 当前会话可见 Bot 的展示名，交接消息按来源名渲染。 */
  agentNames?: ReadonlyMap<string, string>;
}

export interface ConversationAgentOptions {
  store: ConversationStore;
  tools: ToolRegistry;
  id?: AgentId;
  identity?: BotIdentity;
  discovery?: BotDiscovery;
  profile?: ConversationAgentProfile;
  /** 测试或结构化输出实现注入；缺省视为普通回复。 */
  result?: (input: ConversationAgentInput, runId: string) => Promise<BotTurnResult | undefined>;
}

export function createConversationAgentDefinition({
  store,
  tools,
  id = CONVERSATION_AGENT_ID,
  identity = GENERAL_IDENTITY,
  discovery = GENERAL_DISCOVERY,
  profile = CHAT_PROFILES["general-chat"],
  result,
}: ConversationAgentOptions): AgentDefinition<ConversationAgentInput> {
  return {
    id,
    identity,
    discovery,
    modelRoute: "chat",
    ...(result ? { result } : {}),
    async prepare(input, signal, emitter) {
      const activeProfile = input.profile ?? profile;
      const messages = await buildModelMessages({
        conversationId: input.conversationId,
        request: input.request,
        includeHistory: activeProfile.includeHistory,
        injectTime: activeProfile.injectTime ?? false,
        store,
        ...(input.viewerAgentId ? { viewerAgentId: input.viewerAgentId } : {}),
        ...(input.agentNames ? { agentNames: input.agentNames } : {}),
      });
      const toolSet =
        activeProfile.tools.length === 0
          ? undefined
          : tools.authorize(activeProfile.tools, {
              signal,
              workspaceRoot: input.workspaceRoot,
              runId: input.runId,
              sessionId: input.conversationId,
              ...(input.readFileState ? { readFileState: input.readFileState } : {}),
              ...(emitter ? { onToolOutput: emitter.toolOutput } : {}),
            });
      const system = toolSet
        ? [
            activeProfile.systemPrompt,
            buildEnvironmentSystemContext(readRuntimeEnvironment()),
            buildWorkspaceSystemContext(input.workspaceRoot),
          ].join("\n\n")
        : activeProfile.systemPrompt;
      return {
        system,
        messages,
        ...(toolSet ? { tools: toolSet, ...createToolStepLimit() } : {}),
      };
    },
  };
}
