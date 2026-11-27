/** 面试演练 Agent：面试官身份的静态定义，共同装配在 agentFactory。 */
import { agentId } from "../core/agent/definition";
import { createInterviewAgent } from "./agentFactory";
import type { InterviewAgentInput } from "./contracts";
import { INTERVIEW_REHEARSAL_SYSTEM_PROMPT, INTERVIEW_REHEARSAL_TOOLS } from "./rehearsal/profile";

export type InterviewRehearsalInput = InterviewAgentInput;

export const INTERVIEW_REHEARSAL_AGENT_ID = agentId("interview.rehearsal");

export const createInterviewRehearsalAgent = createInterviewAgent({
  id: INTERVIEW_REHEARSAL_AGENT_ID,
  identity: {
    name: "面试演练官",
    role: "rehearsal",
    responsibility: "基于候选人档案进行面试演练，并给出可执行的改进建议。",
    owns: ["interview-rehearsal"],
  },
  systemPrompt: INTERVIEW_REHEARSAL_SYSTEM_PROMPT,
  tools: INTERVIEW_REHEARSAL_TOOLS,
});
