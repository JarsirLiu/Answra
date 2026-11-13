/** 通用压缩参数；只描述预算差异，不携带任何领域提示词。 */
/** 首版所有领域共用的保守预算；后续由模型能力端点下发后替换。 */
export const DEFAULT_COMPACTION_PROFILE: CompactionProfile = {
  retainRecentMessages: 12,
  minimumMessagesToSummarize: 4,
  triggerTokens: 96_000,
};

export interface CompactionProfile {
  /** 最近 N 条消息保持原样，不参与摘要。 */
  retainRecentMessages: number;
  /** 一次至少摘要多少条旧消息才值得调用模型。 */
  minimumMessagesToSummarize: number;
  /** 估算上下文达到该 token 数才触发压缩。 */
  triggerTokens: number;
}

export function assertCompactionProfile(profile: CompactionProfile): void {
  if (!Number.isInteger(profile.retainRecentMessages) || profile.retainRecentMessages < 1)
    throw new Error("压缩保留消息数必须是正整数");
  if (
    !Number.isInteger(profile.minimumMessagesToSummarize) ||
    profile.minimumMessagesToSummarize < 1
  )
    throw new Error("压缩最少摘要消息数必须是正整数");
  if (!Number.isInteger(profile.triggerTokens) || profile.triggerTokens < 1)
    throw new Error("压缩触发 token 数必须是正整数");
}
