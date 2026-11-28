/**
 * 面试域静态 Agent 的共同装配：画像只读上下文、工作区上下文、工具授权与请求投影。
 * 领域差异只通过身份、prompt、授权清单和可选开场指令注入，不由 renderer 提供。
 */
import { buildWorkspaceSystemContext } from "../conversation/turn/workspaceContext";
import type { AgentDefinition, AgentId, BotIdentity } from "../core/agent/definition";
import { createToolStepLimit } from "../core/agent/toolStepLimit";
import { projectContextMessages } from "../core/context/projection";
import type { ToolId, ToolRegistry } from "../core/tool";
import { latestCheckpoint } from "../core/transcript/contextCheckpoint";
import { projectConversationMessages } from "../core/transcript/projection";
import type { ConversationStore } from "../core/transcript/store";
import type { InterviewAgentInput } from "./contracts";
import { buildInterviewMemorySystemContext } from "./profileContext";

export interface InterviewAgentConfig {
  id: AgentId;
  identity: BotIdentity;
  systemPrompt: string;
  tools: readonly ToolId[];
  openingPrompt?: string;
  /** 资料整理者被交接时的开场指令；只影响模型请求，不写 user 消息。 */
  handoffPrompt?: (task: string) => string;
}

export interface InterviewAgentDependencies {
  store: ConversationStore;
  tools: ToolRegistry;
}

export function createInterviewAgent(
  config: InterviewAgentConfig,
): (deps: InterviewAgentDependencies) => AgentDefinition<InterviewAgentInput> {
  return ({ store, tools }) => ({
    id: config.id,
    identity: config.identity,
    discovery: { visibleTo: { kind: "team", teamId: "interview" } },
    modelRoute: "chat",
    async prepare(input, signal, emitter) {
      const snapshot = await store.load(input.conversationId);
      const messages = projectContextMessages({
        messages: snapshot.messages,
        checkpoint: latestCheckpoint(await store.loadContextState(input.conversationId)),
        project: (tail) =>
          projectConversationMessages({
            messages: tail,
            ...(snapshot.activeMessageId === undefined
              ? {}
              : { activeMessageId: snapshot.activeMessageId }),
          }),
      });
      if (input.opening) {
        const openingPrompt =
          input.handoffTask !== null && config.handoffPrompt
            ? config.handoffPrompt(input.handoffTask)
            : config.openingPrompt;
        if (openingPrompt) messages.push({ role: "user", content: openingPrompt });
      }
      const toolSet = tools.authorize(config.tools, {
        signal,
        workspaceRoot: input.workspaceRoot,
        runId: input.runId,
        sessionId: input.conversationId,
        ...(emitter ? { onToolOutput: emitter.toolOutput } : {}),
      });
      return {
        system: [
          config.systemPrompt,
          buildInterviewMemorySystemContext(input.interviewDataRoot, input.profileSeed),
          buildWorkspaceSystemContext(input.workspaceRoot),
        ].join("\n\n"),
        messages,
        tools: toolSet,
        ...createToolStepLimit(),
      };
    },
  });
}
