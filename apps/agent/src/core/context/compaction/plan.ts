/** 选择可摘要的旧消息与保留的当前回合；只按完整 transcript 消息切分。 */
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

/**
 * 摘要后保留多少原始消息：
 * - `none`：手动压缩，模型投影只保留摘要；
 * - `current-user-turn`：保留最后一条真实用户消息及其后的当前回合。
 */
export type CompactionRetention = "none" | "current-user-turn";

interface CompactionPlanInput {
  messages: readonly ConversationMessage[];
  checkpoint: ContextCheckpoint | undefined;
  profile: CompactionProfile;
  retention: CompactionRetention;
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
  const summarizeCount =
    input.retention === "none" ? pending.length : lastUserMessageIndex(pending);
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

/** 没有用户消息时摘要全部，避免把内部运行的历史永久留在投影里。 */
function lastUserMessageIndex(messages: readonly ConversationMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return index;
  }
  return messages.length;
}
