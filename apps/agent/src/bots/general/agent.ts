/** General conversation Agent 定义：组装对话 profile、transcript 上下文和授权工具集。 */
import type { ConversationSendRequest } from "@answra/shared";
import {
  buildEnvironmentSystemContext,
  readRuntimeEnvironment,
} from "../../conversation/turn/environmentContext";
import { buildModelMessages } from "../../conversation/turn/modelMessages";
import { buildWorkspaceSystemContext } from "../../conversation/turn/workspaceContext";
import type {
  AgentDefinition,
  AgentId,
  BotDiscovery,
  BotIdentity,
  BotTurnResult,
} from "../../core/agent/definition";
import { agentId } from "../../core/agent/definition";
import { createToolStepLimit } from "../../core/agent/toolStepLimit";
import type { InstructionLoader } from "../../core/instruction";
import { createInstructionLoader, renderInstructionContext } from "../../core/instruction";
import type { SkillCatalog } from "../../core/skill/catalog";
import { renderSkillIndex, selectSkills } from "../../core/skill/guidance";
import type { ToolRegistry } from "../../core/tool";
import { SKILL_TOOL_ID } from "../../core/tool/ids";
import type { ConversationStore } from "../../core/transcript/store";
import { CHAT_PROFILES, type ChatProfile } from "./profile";

export type ConversationAgentProfile = ChatProfile;

export const CONVERSATION_TEAM_ID = "conversation";
export const GENERAL_AGENT_ID = agentId("conversation.general");

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
  /** 会话级 skill 目录；缺省表示本会话没有可用 skill。 */
  skills?: SkillCatalog;
  /** AGENTS.md 加载器；缺省只加载当前工作区，不读全局文件。 */
  instructions?: InstructionLoader;
  /** 测试或结构化输出实现注入；缺省视为普通回复。 */
  result?: (input: ConversationAgentInput, runId: string) => Promise<BotTurnResult | undefined>;
}

export function createAgentDefinition({
  store,
  tools,
  id = GENERAL_AGENT_ID,
  identity = GENERAL_IDENTITY,
  discovery = GENERAL_DISCOVERY,
  profile = CHAT_PROFILES["general-chat"],
  skills,
  instructions = createInstructionLoader({ globalFile: null }),
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
        store,
        ...(input.viewerAgentId ? { viewerAgentId: input.viewerAgentId } : {}),
        ...(input.agentNames ? { agentNames: input.agentNames } : {}),
      });
      const instructionContext = renderInstructionContext(
        await instructions.load(input.workspaceRoot),
      );
      const authorizedToolIds = skills
        ? [...activeProfile.tools, SKILL_TOOL_ID]
        : activeProfile.tools;
      const toolSet =
        authorizedToolIds.length === 0
          ? undefined
          : tools.authorize(authorizedToolIds, {
              signal,
              workspaceRoot: input.workspaceRoot,
              runId: input.runId,
              sessionId: input.conversationId,
              ...(emitter ? { onToolOutput: emitter.toolOutput } : {}),
            });
      const skillIndex = skills
        ? renderSkillIndex(selectSkills(skills.list(), activeProfile.skills))
        : "";
      const system = toolSet
        ? [
            activeProfile.systemPrompt,
            buildEnvironmentSystemContext(readRuntimeEnvironment()),
            buildWorkspaceSystemContext(input.workspaceRoot),
            ...(instructionContext ? [instructionContext] : []),
            ...(skillIndex ? [skillIndex] : []),
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
