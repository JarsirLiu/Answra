/** transcript 的上下文状态事实；不调用模型，也不定义摘要策略。 */
import type { ContextCompactionStatus, ContextPruningStatus, ContextUsage } from "@answra/shared";
import type { ContextCheckpoint } from "./contextCheckpoint";

/** 成功 run 首个 step 的实际输入 token 与同一请求的保守估算。 */
export interface ContextUsageAnchor {
  /** provider 返回的首个 step 输入 token。 */
  inputTokens: number;
  /** 产生该 step 的最终请求在发送前的保守估算。 */
  estimatedTokens: number;
  createdAt: string;
}

export interface ContextState {
  checkpoints: readonly ContextCheckpoint[];
  /** 最近一次压缩生命周期；快照只投影这一字段，检查点正文留在 store。 */
  compaction?: ContextCompactionStatus;
  /** 最近一次成功 run 的 usage 校准锚点；投影变化或 run 失败后失效。 */
  usageAnchor?: ContextUsageAnchor;
  /** 最近一次模型请求的上下文占用与阈值；只用于 UI 展示。 */
  usage?: ContextUsage;
  /** 最近一次实际应用的旧工具结果清理；下一次请求未清理时清除。 */
  pruning?: ContextPruningStatus;
  /** 已应用到模型投影的旧工具结果 ID；只存 ID，不存正文，下一轮请求重新套用。 */
  prunedToolCallIds?: readonly string[];
  /** 连续压缩失败次数；成功后清除，用于自动熔断。 */
  compactionFailureCount?: number;
  /** 熔断解除时间；到期后允许自动压缩再次尝试。 */
  compactionRetryAt?: string;
}
