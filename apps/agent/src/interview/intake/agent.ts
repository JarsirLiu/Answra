/** 面试资料整理 Agent：读取简历/项目并维护画像；开场只影响模型输入，不写 user 消息。 */
import { buildWorkspaceSystemContext } from "../../conversation/turn/workspaceContext";
import type { AgentDefinition } from "../../core/agent/definition";
import { agentId } from "../../core/agent/definition";
import { createToolStepLimit } from "../../core/agent/toolStepLimit";
import { projectContextMessages } from "../../core/context/projection";
import type { ToolRegistry } from "../../core/tool";
import { latestCheckpoint } from "../../core/transcript/contextCheckpoint";
import { projectConversationMessages } from "../../core/transcript/projection";
import type { ConversationStore } from "../../core/transcript/store";
import type { InterviewAgentInput } from "../contracts";
import { buildInterviewMemorySystemContext } from "../profileContext";
import {
  INTERVIEW_INTAKE_OPENING_PROMPT,
  INTERVIEW_INTAKE_SYSTEM_PROMPT,
  INTERVIEW_INTAKE_TOOLS,
} from "./profile";

export type InterviewIntakeInput = InterviewAgentInput;

export const INTERVIEW_INTAKE_AGENT_ID = agentId("interview.intake");

export function createInterviewIntakeAgent({
  store,
  tools,
}: {
  store: ConversationStore;
  tools: ToolRegistry;
}): AgentDefinition<InterviewIntakeInput> {
  return {
    id: INTERVIEW_INTAKE_AGENT_ID,
    identity: {
      name: "面试资料整理者",
      role: "intake",
      responsibility: "读取简历和项目资料，通过对话补全候选人画像。",
      owns: ["interview-intake"],
    },
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
        messages.push({ role: "user", content: INTERVIEW_INTAKE_OPENING_PROMPT });
      }
      const toolSet = tools.authorize(INTERVIEW_INTAKE_TOOLS, {
        signal,
        workspaceRoot: input.workspaceRoot,
        runId: input.runId,
        sessionId: input.conversationId,
        ...(emitter ? { onToolOutput: emitter.toolOutput } : {}),
      });
      return {
        system: [
          INTERVIEW_INTAKE_SYSTEM_PROMPT,
          buildInterviewMemorySystemContext(input.interviewDataRoot, input.profileSeed),
          buildWorkspaceSystemContext(input.workspaceRoot),
        ].join("\n\n"),
        messages,
        tools: toolSet,
        ...createToolStepLimit(),
      };
    },
  };
}
