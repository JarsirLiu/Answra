/** transcript 的上下文检查点事实；不调用模型，也不定义摘要策略。 */
import type {
  ContextCompactionBoundary,
  ContextCompactionStatus,
  ConversationMessage,
} from "@answra/shared";

/** 一次已完成摘要的边界；summary 是 synthetic user message 的正文。 */
export interface ContextCheckpoint {
  summary: string;
  /** 摘要覆盖的最后一条 transcript 消息 ID。 */
  throughMessageId: string;
  createdAt: string;
  /** 摘要覆盖的累计消息数，用于诊断和后续归档。 */
  messageCount: number;
}

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
}

export function latestCheckpoint(state: ContextState | undefined): ContextCheckpoint | undefined {
  return state?.checkpoints.at(-1);
}

/** 返回检查点之后的消息；检查点引用的消息已不存在时返回 undefined。 */
export function messagesAfterCheckpoint(
  messages: readonly ConversationMessage[],
  checkpoint: ContextCheckpoint | undefined,
): ConversationMessage[] | undefined {
  if (!checkpoint) return [...messages];
  const index = messages.findIndex((message) => message.id === checkpoint.throughMessageId);
  return index < 0 ? undefined : messages.slice(index + 1);
}

/** 只把检查点边界投影给 UI；摘要正文仍留在 store 内。 */
export function compactionBoundaries(state: ContextState | undefined): ContextCompactionBoundary[] {
  return (state?.checkpoints ?? []).map((checkpoint) => ({
    id: `compaction:${checkpoint.createdAt}:${checkpoint.throughMessageId}`,
    throughMessageId: checkpoint.throughMessageId,
    createdAt: checkpoint.createdAt,
  }));
}
