/** 把工具原始输出压进模型可见预算；artifact 尚未实现，显式失败而不是静默降级。 */
import type { ToolResultBudget } from "../contracts";
import { ToolExecutionError } from "./result";

export interface BudgetedContent {
  readonly modelContent: string;
  readonly truncated: boolean;
}

export function applyResultBudget(value: string, budget: ToolResultBudget): BudgetedContent {
  switch (budget.strategy) {
    case "inline":
      return { modelContent: value, truncated: false };
    case "truncate": {
      const byteLimited =
        budget.maxModelBytes === undefined
          ? { text: value, truncated: false }
          : truncateUtf8(value, budget.maxModelBytes);
      const charLimited =
        byteLimited.text.length <= budget.maxModelChars
          ? byteLimited
          : { text: byteLimited.text.slice(0, budget.maxModelChars), truncated: true };
      return {
        modelContent: charLimited.truncated
          ? `${charLimited.text}\n[输出已截断]`
          : charLimited.text,
        truncated: charLimited.truncated,
      };
    }
    case "artifact":
      throw new ToolExecutionError("unsupported-budget", "artifact 结果预算尚未实现");
  }
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { text: value, truncated: false };
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    bytes += characterBytes;
    end += character.length;
  }
  return { text: value.slice(0, end), truncated: true };
}
