import type { ContextPruningStatus, ContextUsage } from "@answra/shared";

export function formatContextTokens(tokens: number): string {
  if (tokens < 1_000) return `${tokens}`;
  const thousands = tokens / 1_000;
  return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}k`;
}

export function contextUsagePercent(usage: ContextUsage): number {
  if (usage.contextWindow <= 0) return 0;
  return Math.min(100, Math.round((usage.usedTokens / usage.contextWindow) * 100));
}

/** 只有 provider 实测和压缩后重建估算可作为当前展示值；普通发送前估算不展示。 */
export function isReportedContextUsage(usage: ContextUsage): boolean {
  return usage.source === "provider" || usage.source === "compaction";
}

export function contextPruningLabel(status: ContextPruningStatus): string {
  return `已清理 ${status.prunedCount} 个旧工具结果，节省约 ${formatContextTokens(
    status.savedTokens,
  )} token`;
}
