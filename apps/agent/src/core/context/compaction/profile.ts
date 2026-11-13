/** 通用压缩参数；只描述保留策略，不携带 token 预算或领域提示词。 */
export const DEFAULT_COMPACTION_PROFILE: CompactionProfile = {
  retainRecentMessages: 12,
  minimumMessagesToSummarize: 4,
};

export interface CompactionProfile {
  /** 最近 N 条消息保持原样，不参与摘要。 */
  retainRecentMessages: number;
  /** 一次至少摘要多少条旧消息才值得调用模型。 */
  minimumMessagesToSummarize: number;
}

export function assertCompactionProfile(profile: CompactionProfile): void {
  if (!Number.isInteger(profile.retainRecentMessages) || profile.retainRecentMessages < 1)
    throw new Error("压缩保留消息数必须是正整数");
  if (
    !Number.isInteger(profile.minimumMessagesToSummarize) ||
    profile.minimumMessagesToSummarize < 1
  )
    throw new Error("压缩最少摘要消息数必须是正整数");
}
