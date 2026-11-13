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
}: {
  messages: readonly ConversationMessage[];
  checkpoint: ContextCheckpoint | undefined;
  profile: CompactionProfile;
}): CompactionPlan | undefined {
  const pending = messagesAfterCheckpoint(messages, checkpoint);
  if (!pending) return undefined;
  const contextTokens =
    estimateTextTokens(checkpoint?.summary ?? "") + estimateMessagesTokens(pending);
  if (contextTokens < profile.triggerTokens) return undefined;
  const summarizeCount = pending.length - profile.retainRecentMessages;
  if (summarizeCount < profile.minimumMessagesToSummarize) return undefined;
  return {
    messagesToSummarize: pending.slice(0, summarizeCount),
    retainedMessages: pending.slice(summarizeCount),
  };
}
