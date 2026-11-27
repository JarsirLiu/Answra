/** 面试辅助教练 Agent：候选者视角的回答建议，共同装配在 agentFactory。 */
import { agentId } from "../../core/agent/definition";
import { createInterviewAgent } from "../agentFactory";
import type { InterviewAgentInput } from "../contracts";
import {
  INTERVIEW_COACH_OPENING_PROMPT,
  INTERVIEW_COACH_SYSTEM_PROMPT,
  INTERVIEW_COACH_TOOLS,
} from "./profile";

export type InterviewCoachInput = InterviewAgentInput;

export const INTERVIEW_COACH_AGENT_ID = agentId("interview.coach");

export const createInterviewCoachAgent = createInterviewAgent({
  id: INTERVIEW_COACH_AGENT_ID,
  identity: {
    name: "面试辅助教练",
    role: "coach",
    responsibility: "基于候选人档案与面试官问题，给出第一人称回答建议。",
    owns: ["interview-assist"],
  },
  systemPrompt: INTERVIEW_COACH_SYSTEM_PROMPT,
  tools: INTERVIEW_COACH_TOOLS,
  openingPrompt: INTERVIEW_COACH_OPENING_PROMPT,
});
