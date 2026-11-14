/** 选择可摘要的旧消息与保留尾段；只按完整 transcript 消息切分。 */
import type { ConversationMessage } from "@answra/shared";
import {
  type ContextCheckpoint,
  messagesAfterCheckpoint,
} from "../../transcript/contextCheckpoint";
import { estimateMessagesTokens, estimateTextTokens } from "../tokenEstimate";
import type { CompactionProfile } from "./profile";

export interface CompactionPlan {
  messagesToSummarize: readonly ConversationMessage[];
  retainedMessages: readonly ConversationMessage[];
}

export type CompactionSkipReason =
  | "below-threshold"
  | "insufficient-messages"
  | "checkpoint-invalid";

export type CompactionPlanDecision =
  | { status: "plan"; plan: CompactionPlan }
  | { status: "skip"; reason: CompactionSkipReason };

interface CompactionPlanInput {
  messages: readonly ConversationMessage[];
  checkpoint: ContextCheckpoint | undefined;
  profile: CompactionProfile;
  triggerTokens: number;
  /** 最终模型请求的估算值；缺省时退回摘要 + checkpoint 后消息的旧估算。 */
  contextTokens?: number;
  /** 手动压缩跳过触发点判断，但仍要求满足最少可摘要消息数。 */
  force?: boolean;
}

/** 决定是否压缩以及跳过原因；调用方不得再自行复制这套判定。 */
export function decideCompaction(input: CompactionPlanInput): CompactionPlanDecision {
  const pending = messagesAfterCheckpoint(input.messages, input.checkpoint);
  if (!pending) return { status: "skip", reason: "checkpoint-invalid" };
  const estimatedTokens =
    input.contextTokens ??
    estimateTextTokens(input.checkpoint?.summary ?? "") + estimateMessagesTokens(pending);
  if (!input.force && estimatedTokens < input.triggerTokens) {
    return { status: "skip", reason: "below-threshold" };
  }
  const summarizeCount = pending.length - input.profile.retainRecentMessages;
  if (summarizeCount < input.profile.minimumMessagesToSummarize) {
    return { status: "skip", reason: "insufficient-messages" };
  }
  return {
    status: "plan",
    plan: {
      messagesToSummarize: pending.slice(0, summarizeCount),
      retainedMessages: pending.slice(summarizeCount),
    },
  };
}

export function planCompaction(input: CompactionPlanInput): CompactionPlan | undefined {
  const decision = decideCompaction(input);
  return decision.status === "plan" ? decision.plan : undefined;
}
