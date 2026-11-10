/** 面试演练 Agent：组装演练提示、记忆路径、工作区上下文与授权工具。 */
import type { ModelMessage } from "ai";
import { buildWorkspaceSystemContext } from "../conversation/turn/workspaceContext";
import type { AgentDefinition } from "../core/agent/definition";
import { agentId } from "../core/agent/definition";
import { createToolStepLimit } from "../core/agent/toolStepLimit";
import type { ReadFileStateMap, ToolRegistry } from "../core/tool";
import type { ConversationStore } from "../core/transcript/store";
import {
  buildInterviewMemorySystemContext,
  INTERVIEW_REHEARSAL_SYSTEM_PROMPT,
  INTERVIEW_REHEARSAL_TOOLS,
} from "./rehearsal/profile";

export interface InterviewRehearsalInput {
  conversationId: string;
  runId: string;
  workspaceRoot: string | null;
  interviewDataRoot: string | null;
  readFileState?: ReadFileStateMap;
}

export function createInterviewRehearsalAgent({
  store,
  tools,
}: {
  store: ConversationStore;
  tools: ToolRegistry;
}): AgentDefinition<InterviewRehearsalInput> {
  return {
    id: agentId("interview.rehearsal"),
    modelRoute: "chat",
    async prepare(input, signal, emitter) {
      const snapshot = await store.load(input.conversationId);
      const messages: ModelMessage[] = snapshot.messages
        .filter((message) => message.status !== "streaming")
        .map((message) => ({ role: message.role, content: message.text }));
      const toolSet = tools.authorize(INTERVIEW_REHEARSAL_TOOLS, {
        signal,
        workspaceRoot: input.workspaceRoot,
        runId: input.runId,
        sessionId: input.conversationId,
        ...(input.readFileState ? { readFileState: input.readFileState } : {}),
        ...(emitter ? { onToolOutput: emitter.toolOutput } : {}),
      });
      return {
        system: [
          INTERVIEW_REHEARSAL_SYSTEM_PROMPT,
          buildInterviewMemorySystemContext(input.interviewDataRoot),
          buildWorkspaceSystemContext(input.workspaceRoot),
        ].join("\n\n"),
        messages,
        tools: toolSet,
        ...createToolStepLimit(),
      };
    },
  };
}
