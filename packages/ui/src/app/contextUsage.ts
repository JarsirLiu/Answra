import type { ContextPruningStatus, ContextUsage } from "@answra/shared";

export function formatContextTokens(tokens: number): string {
  if (tokens < 1_000) return `${tokens}`;
  const thousands = tokens / 1_000;
  return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}k`;
}

export function contextUsagePercent(usage: ContextUsage): number {
  if (usage.inputLimit <= 0) return 0;
  return Math.min(100, Math.round((usage.usedTokens / usage.inputLimit) * 100));
}

export function contextUsageLabel(usage: ContextUsage): string {
  return `上下文约 ${formatContextTokens(usage.usedTokens)} / ${formatContextTokens(
    usage.inputLimit,
  )}（${contextUsagePercent(usage)}%）· 工具清理 ${formatContextTokens(
    usage.pruneAt,
  )} · 摘要压缩 ${formatContextTokens(usage.compactAt)}`;
}

export function contextPruningLabel(status: ContextPruningStatus): string {
  return `已清理 ${status.prunedCount} 个旧工具结果，节省约 ${formatContextTokens(
    status.savedTokens,
  )} token`;
}
