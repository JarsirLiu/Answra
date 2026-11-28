/** 面试资料整理 Agent：读取简历/项目并维护画像；开场只影响模型输入，不写 user 消息。 */
import { agentId } from "../../core/agent/definition";
import { createInterviewAgent } from "../agentFactory";
import type { InterviewAgentInput } from "../contracts";
import {
  INTERVIEW_INTAKE_OPENING_PROMPT,
  INTERVIEW_INTAKE_SYSTEM_PROMPT,
  INTERVIEW_INTAKE_TOOLS,
  interviewIntakeHandoffPrompt,
} from "./profile";

export type InterviewIntakeInput = InterviewAgentInput;

export const INTERVIEW_INTAKE_AGENT_ID = agentId("interview.intake");

export const createInterviewIntakeAgent = createInterviewAgent({
  id: INTERVIEW_INTAKE_AGENT_ID,
  identity: {
    name: "面试资料整理者",
    role: "intake",
    responsibility: "读取简历和项目资料，通过对话补全候选人画像。",
    owns: ["interview-intake"],
  },
  systemPrompt: INTERVIEW_INTAKE_SYSTEM_PROMPT,
  tools: INTERVIEW_INTAKE_TOOLS,
  openingPrompt: INTERVIEW_INTAKE_OPENING_PROMPT,
  handoffPrompt: interviewIntakeHandoffPrompt,
});
