/** 通用压缩参数；只描述结构约束，不携带 token 预算、保留条数或领域提示词。 */
export const DEFAULT_COMPACTION_PROFILE: CompactionProfile = {
  minimumMessagesToSummarize: 4,
};

export interface CompactionProfile {
  /** 一次至少摘要多少条旧消息才值得调用模型。 */
  minimumMessagesToSummarize: number;
}

export function assertCompactionProfile(profile: CompactionProfile): void {
  if (
    !Number.isInteger(profile.minimumMessagesToSummarize) ||
    profile.minimumMessagesToSummarize < 1
  )
    throw new Error("压缩最少摘要消息数必须是正整数");
}
