/** 旧工具结果清理策略：哪些结果可清、保留多少最近结果和消息；不承载 token 阈值。 */
import { GREP_TOOL_NAME, READ_TOOL_NAME, RUN_COMMAND_TOOL_NAME } from "../../tool/toolNames";

export interface ToolResultPruningPolicy {
  /** 允许清理旧结果的模型工具名；按 ModelMessage.toolName 匹配。 */
  readonly clearableToolNames: readonly string[];
  /** 最近 N 个可清理结果保持原样。 */
  readonly protectedRecentResults: number;
  /** 最近 N 条模型消息内的结果保持原样。 */
  readonly protectedRecentMessages: number;
}

export const DEFAULT_TOOL_RESULT_PRUNING_POLICY: ToolResultPruningPolicy = {
  clearableToolNames: [READ_TOOL_NAME, GREP_TOOL_NAME, RUN_COMMAND_TOOL_NAME],
  protectedRecentResults: 5,
  protectedRecentMessages: 12,
};

export function assertToolResultPruningPolicy(policy: ToolResultPruningPolicy): void {
  for (const name of policy.clearableToolNames) {
    if (!name.trim()) throw new Error("可清理工具名不能为空");
  }
  assertNonNegativeInteger(policy.protectedRecentResults, "protectedRecentResults");
  assertNonNegativeInteger(policy.protectedRecentMessages, "protectedRecentMessages");
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} 必须是非负整数`);
}
