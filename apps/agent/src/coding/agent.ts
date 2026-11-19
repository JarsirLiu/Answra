/** CLI coding Agent 定义：组装独立 prompt、transcript 上下文、skill 索引和编码工具授权。 */
import type { ConversationSendRequest } from "@answra/shared";
import type { AgentDefinition, BotDiscovery, BotIdentity } from "../core/agent/definition";
import { agentId } from "../core/agent/definition";
import { createToolStepLimit } from "../core/agent/toolStepLimit";
import type { InstructionLoader } from "../core/instruction";
import { createInstructionLoader, renderInstructionContext } from "../core/instruction";
import type { SkillCatalog } from "../core/skill/catalog";
import { renderSkillIndex, selectSkills } from "../core/skill/guidance";
import type { ToolRegistry } from "../core/tool";
import { SKILL_TOOL_ID } from "../core/tool/ids";
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
}

export function createCodingAgentDefinition({
  store,
  tools,
  skills,
  instructions = createInstructionLoader({ globalFile: null }),
}: {
  store: ConversationStore;
  tools: ToolRegistry;
  /** 会话级 skill 目录；缺省表示本会话没有可用 skill。 */
  skills?: SkillCatalog;
  /** AGENTS.md 加载器；缺省只加载当前工作区，不读全局文件。 */
  instructions?: InstructionLoader;
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
      const instructionContext = renderInstructionContext(
        await instructions.load(input.workspaceRoot),
      );
      const authorizedToolIds = skills
        ? [...input.policy.tools, SKILL_TOOL_ID]
        : input.policy.tools;
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
        ? renderSkillIndex(selectSkills(skills.list(), input.policy.skills))
        : "";
      const system = toolSet
        ? [
            input.policy.systemPrompt,
            buildCodingEnvironmentContext(),
            buildCodingWorkspaceContext(input.workspaceRoot),
            ...(instructionContext ? [instructionContext] : []),
            ...(skillIndex ? [skillIndex] : []),
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
