/** Claude Code 对齐的压缩文案；只服务 CLI/TUI，不进入共享 snapshot。 */
export const COMPACTION_HISTORY_SHORTCUT = "ctrl+o";
export const COMPACTION_SPINNER_MESSAGE = "Compacting conversation";
export const COMPACTION_FAILURE_TEXT = "Error compacting conversation";
export const COMPACTION_BOUNDARY_TEXT = `✻ Conversation compacted (${COMPACTION_HISTORY_SHORTCUT} for history)`;
export const COMPACTION_SUMMARY_TITLE = "Summarized conversation";
export const COMPACTION_SUMMARY_HINT = `(${COMPACTION_HISTORY_SHORTCUT} to expand history)`;
export const COMPACTION_SUMMARY_FALLBACK_TITLE = "Compact summary";
export const COMPACTION_SUMMARY_FALLBACK_HINT = `(${COMPACTION_HISTORY_SHORTCUT} to expand)`;

export function compactionSummaryCountText(count: number): string {
  return `Summarized ${count} messages up to this point`;
}

export function compactionContextText(instructions: string): string {
  return `Context: “${instructions}”`;
}
