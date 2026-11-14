/** 把检查点投影成 UI 可见的压缩边界；摘要正文只在边界内回放。 */
import type { ContextCompactionBoundary } from "@answra/shared";
import type { ContextState } from "./contextState";

export function compactionBoundaries(state: ContextState | undefined): ContextCompactionBoundary[] {
  return (state?.checkpoints ?? []).map((checkpoint) => ({
    id: `compaction:${checkpoint.createdAt}:${checkpoint.throughMessageId}`,
    throughMessageId: checkpoint.throughMessageId,
    createdAt: checkpoint.createdAt,
    summary: checkpoint.summary,
    summarizedMessages: checkpoint.messageCount,
    ...(checkpoint.instructions === undefined ? {} : { instructions: checkpoint.instructions }),
  }));
}
