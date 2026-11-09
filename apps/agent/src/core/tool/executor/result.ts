/** 工具执行内部错误与失败结果工厂；不写事件，也不决定 AI SDK 如何呈现错误。 */
import type { ToolFailure, ToolFailureCode } from "../contracts";

export class ToolExecutionError extends Error {
  constructor(
    readonly code: ToolFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "ToolExecutionError";
  }
}

export function toFailure(code: ToolFailureCode, message: string, startedAt: number): ToolFailure {
  return {
    success: false,
    error: { code, message },
    durationMs: Date.now() - startedAt,
  };
}
