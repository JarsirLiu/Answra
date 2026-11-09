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
    case "truncate":
      if (value.length <= budget.maxModelChars) return { modelContent: value, truncated: false };
      return {
        modelContent: `${value.slice(0, budget.maxModelChars)}\n[输出已截断]`,
        truncated: true,
      };
    case "artifact":
      throw new ToolExecutionError("unsupported-budget", "artifact 结果预算尚未实现");
  }
}
