/** 演练/辅助 Agent 唯一的阶段交接工具：只提交请求，不写画像、不切阶段。 */
import type { JSONSchema7 } from "ai";
import { defineTool, type ToolHandlerFailure, toolId } from "../../core/tool";
import {
  INTERVIEW_PROFILE_REVIEW_REASONS,
  type InterviewProfileReviewReason,
  type InterviewProfileReviewRequests,
} from "./profileReviewRequests";

export const INTERVIEW_PROFILE_REVIEW_TOOL_ID = toolId("interview.request-profile-review");
export const INTERVIEW_PROFILE_REVIEW_TOOL_NAME = "interview.request-profile-review";
export const INTERVIEW_PROFILE_REVIEW_SUMMARY_MAX_CHARS = 2_000;

interface ProfileReviewInput {
  reason: InterviewProfileReviewReason;
  summary: string;
}

interface ProfileReviewOutput {
  accepted: true;
  reason: InterviewProfileReviewReason;
  summary: string;
}

const PROFILE_REVIEW_TOOL_DESCRIPTION = [
  "请求结束当前面试阶段，把候选人画像交给资料整理者更新。",
  "",
  "只在以下情况调用：",
  "1. 本场演练或真实面试已经结束，你已经给出结束语；",
  "2. 用户明确要求补充、修改或重做候选人画像；",
  "3. 画像缺少关键事实，继续提问只会变成编造，且你已经向用户说明缺什么并得到同意。",
  "",
  "禁止在一场进行中的演练/面试里调用；普通追问、单个细节缺失、用户还没回答完都不算“必须”。",
  "调用后本轮结束时会进入资料整理阶段；不要再提问，用一句话说明当前阶段结束并交给资料整理者。",
].join("\n");

const PROFILE_REVIEW_INPUT_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {
    reason: {
      type: "string",
      enum: [...INTERVIEW_PROFILE_REVIEW_REASONS],
      description: "触发交接的原因；必须是三个允许值之一。",
    },
    summary: {
      type: "string",
      minLength: 1,
      maxLength: INTERVIEW_PROFILE_REVIEW_SUMMARY_MAX_CHARS,
      description:
        "给资料整理者的交接说明：本场确认或缺失的事实、要改画像的哪一部分；不要复述整段对话。",
    },
  },
  required: ["reason", "summary"],
  additionalProperties: false,
};

const PROFILE_REVIEW_MODEL_CONTENT =
  "已提交资料整理请求。本轮结束后会进入资料整理阶段；请用一句话说明当前阶段结束，不要再提问。";

export function createInterviewProfileReviewTool(requests: InterviewProfileReviewRequests) {
  return defineTool<ProfileReviewInput, ProfileReviewOutput>({
    id: INTERVIEW_PROFILE_REVIEW_TOOL_ID,
    metadata: {
      name: INTERVIEW_PROFILE_REVIEW_TOOL_NAME,
      description: PROFILE_REVIEW_TOOL_DESCRIPTION,
      readOnly: false,
      destructive: false,
      concurrentSafe: false,
      sideEffectScope: "userInteraction",
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
      resultBudget: { strategy: "inline", maxModelChars: 4_096 },
    },
    inputSchema: PROFILE_REVIEW_INPUT_SCHEMA,
    handler: async (input, context) => recordReview(requests, context.sessionId, input),
    formatModelContent: () => PROFILE_REVIEW_MODEL_CONTENT,
  });
}

function recordReview(
  requests: InterviewProfileReviewRequests,
  sessionId: string,
  input: ProfileReviewInput,
): ProfileReviewOutput | ToolHandlerFailure {
  const summary = input.summary.trim();
  if (!summary) {
    return { ok: false, code: "invalid-input", message: "交接说明不能为空" };
  }
  requests.record(sessionId, { reason: input.reason, summary });
  return { accepted: true, reason: input.reason, summary };
}
