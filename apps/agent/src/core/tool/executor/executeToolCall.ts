/** 单次工具调用：输入校验、归一化、超时/取消、handler、结果预算与模型投影。 */
import {
  type AnyToolEntry,
  isToolHandlerFailure,
  type ToolContext,
  type ToolResult,
} from "../contracts";
import { ToolExecutionError, toFailure } from "./result";
import { applyResultBudget } from "./resultBudget";
import { runWithToolTimeout } from "./timeout";

export async function executeToolCall(
  entry: AnyToolEntry,
  rawInput: unknown,
  context: ToolContext,
): Promise<ToolResult> {
  const startedAt = Date.now();
  if (context.signal.aborted) return toFailure("aborted", "工具调用已取消", startedAt);

  const invalid = entry.validateInput?.(rawInput);
  if (invalid) return toFailure(invalid.code, invalid.message, startedAt);

  let input: unknown;
  try {
    input = entry.resolveInput ? await entry.resolveInput(rawInput, context) : rawInput;
  } catch (error) {
    if (error instanceof ToolExecutionError) return toFailure(error.code, error.message, startedAt);
    throw error;
  }

  try {
    const output = await runWithToolTimeout(entry.metadata.timeoutMs, context.signal, (signal) =>
      entry.handler(input, { ...context, signal }),
    );
    if (isToolHandlerFailure(output)) return toFailure(output.code, output.message, startedAt);

    const modelContent = entry.formatModelContent
      ? entry.formatModelContent(output)
      : defaultModelContent(output);
    if (byteLength(modelContent) > entry.metadata.maxOutputBytes)
      return toFailure(
        "output-too-large",
        `工具输出超过 ${entry.metadata.maxOutputBytes} 字节上限`,
        startedAt,
      );

    const budgeted = applyResultBudget(modelContent, entry.metadata.resultBudget);
    return {
      success: true,
      output,
      modelContent: budgeted.modelContent,
      truncated: budgeted.truncated,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (error instanceof ToolExecutionError) return toFailure(error.code, error.message, startedAt);
    if (context.signal.aborted) return toFailure("aborted", "工具调用已取消", startedAt);
    throw error;
  }
}

function defaultModelContent(output: unknown): string {
  if (typeof output === "string") return output;
  const serialized = JSON.stringify(output);
  return serialized ?? String(output);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
