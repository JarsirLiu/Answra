/** 选择可摘要的旧消息与保留尾段；只按完整 transcript 消息切分。 */
import type { ConversationMessage } from "@answra/shared";
import type { ContextCheckpoint } from "../../transcript/contextState";
import { messagesAfterCheckpoint } from "../../transcript/contextState";
import { estimateMessagesTokens, estimateTextTokens } from "../tokenEstimate";
import type { CompactionProfile } from "./profile";

export interface CompactionPlan {
  messagesToSummarize: readonly ConversationMessage[];
  retainedMessages: readonly ConversationMessage[];
}

export function planCompaction({
  messages,
  checkpoint,
  profile,
  triggerTokens,
  contextTokens,
  force = false,
}: {
  messages: readonly ConversationMessage[];
  checkpoint: ContextCheckpoint | undefined;
  profile: CompactionProfile;
  triggerTokens: number;
  /** 最终模型请求的估算值；缺省时退回摘要 + checkpoint 后消息的旧估算。 */
  contextTokens?: number;
  /** 手动压缩跳过触发点判断，但仍要求满足最少可摘要消息数。 */
  force?: boolean;
}): CompactionPlan | undefined {
  const pending = messagesAfterCheckpoint(messages, checkpoint);
  if (!pending) return undefined;
  const estimatedTokens =
    contextTokens ??
    estimateTextTokens(checkpoint?.summary ?? "") + estimateMessagesTokens(pending);
  if (!force && estimatedTokens < triggerTokens) return undefined;
  const summarizeCount = pending.length - profile.retainRecentMessages;
  if (summarizeCount < profile.minimumMessagesToSummarize) return undefined;
  return {
    messagesToSummarize: pending.slice(0, summarizeCount),
    retainedMessages: pending.slice(summarizeCount),
  };
}
