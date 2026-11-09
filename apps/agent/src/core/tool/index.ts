/** 跨领域工具系统的公开入口：契约、静态注册表、执行器与内置工具装配。 */

export { createBuiltinToolRegistry } from "./builtin";
export {
  type AnyToolEntry,
  defineTool,
  isToolHandlerFailure,
  type ReadFileStateEntry,
  type ReadFileStateMap,
  type ToolContext,
  type ToolEntry,
  type ToolFailure,
  type ToolFailureCode,
  type ToolHandlerFailure,
  type ToolId,
  type ToolMetadata,
  type ToolResult,
  type ToolResultBudget,
  type ToolSideEffectScope,
  type ToolSuccess,
  type ToolWorkerPaths,
  toolId,
} from "./contracts";
export { executeToolCall } from "./executor/executeToolCall";
export { ToolExecutionError } from "./executor/result";
export { ToolRegistry, type ToolSessionContext } from "./registry";
