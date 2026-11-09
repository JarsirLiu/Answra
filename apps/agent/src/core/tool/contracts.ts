/** Agent 工具的唯一契约：静态身份、能力元数据、输入 schema 与单次调用结果。 */
import type { JSONSchema7 } from "ai";

declare const toolIdBrand: unique symbol;
export type ToolId = string & { readonly [toolIdBrand]: true };

/** 只供 Agent 模块创建静态工具 ID；renderer 输入不经过该工厂。 */
export function toolId(value: string): ToolId {
  if (!value.trim()) throw new Error("工具 ID 不能为空");
  return value as ToolId;
}

export type ToolSideEffectScope =
  | "none"
  | "workspace"
  | "network"
  | "session"
  | "userInteraction"
  | "process";
export type ToolResultBudgetStrategy = "inline" | "truncate" | "artifact";

export interface ToolResultBudget {
  readonly strategy: ToolResultBudgetStrategy;
  /** 模型可见内容的最大字符数；按字符而非字节，避免多字节文本被提前截断。 */
  readonly maxModelChars: number;
  /** 模型可见内容的字节上限；与字符上限同时生效时先裁字节。 */
  readonly maxModelBytes?: number;
}

export interface ToolMetadata {
  /** 模型请求中使用的工具名，也是 ToolSet 的键。 */
  readonly name: string;
  readonly description: string;
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly concurrentSafe: boolean;
  readonly sideEffectScope: ToolSideEffectScope;
  readonly timeoutMs: number;
  /** 工具模型可见内容的字节上限；执行器在 formatModelContent 投影后检查。 */
  readonly maxOutputBytes: number;
  readonly resultBudget: ToolResultBudget;
}

export interface ReadFileStateEntry {
  readonly path: string;
  readonly mtimeMs: number;
  readonly sizeBytes: number;
  readonly offset: number;
  readonly limit: number | undefined;
  readonly partialView: boolean;
}

export type ReadFileStateMap = Map<string, ReadFileStateEntry>;

export interface ToolWorkerPaths {
  readonly grep?: string;
}

export interface ToolContext {
  readonly toolCallId: string;
  readonly signal: AbortSignal;
  readonly workspaceRoot: string | null;
  readonly runId: string;
  readonly sessionId: string;
  readonly readFileState?: ReadFileStateMap;
  readonly workerPaths?: ToolWorkerPaths;
  /** 长命令在结束前增量回报已产生的输出；只用于实时预览，不参与模型结果。 */
  readonly onOutput?: (delta: string) => void;
}

export type ToolFailureCode =
  | "invalid-input"
  | "timeout"
  | "aborted"
  | "handler-failed"
  | "output-too-large"
  | "unsupported-budget";

/** handler 或 validateInput 主动报告的业务失败；基础设施错误仍向上抛。 */
export interface ToolHandlerFailure {
  readonly ok: false;
  readonly code: ToolFailureCode;
  readonly message: string;
}

export interface ToolSuccess<Output = unknown> {
  readonly success: true;
  readonly output: Output;
  readonly modelContent: string;
  readonly durationMs: number;
  readonly truncated: boolean;
}

export interface ToolFailure {
  readonly success: false;
  readonly error: { readonly code: ToolFailureCode; readonly message: string };
  /** 返回给模型的工具结果文本；工具业务失败不是 AI SDK 执行异常。 */
  readonly modelContent: string;
  readonly durationMs: number;
}

export type ToolResult<Output = unknown> = ToolSuccess<Output> | ToolFailure;

export interface ToolEntry<Input = unknown, Output = unknown> {
  readonly id: ToolId;
  readonly metadata: ToolMetadata;
  readonly inputSchema: JSONSchema7;
  handler(input: Input, context: ToolContext): Promise<Output | ToolHandlerFailure>;
  validateInput?(input: unknown): ToolHandlerFailure | undefined;
  resolveInput?(input: Input, context: ToolContext): Input | Promise<Input>;
  formatModelContent?(output: Output): string;
  /** Agent 进程收尾时释放该工具持有的长生命周期资源。 */
  dispose?(): void | Promise<void>;
}

/** 注册表内部擦除泛型后的工具条目；输入已由 AI SDK 按 inputSchema 校验。 */
export type AnyToolEntry = ToolEntry<unknown, unknown>;

export function defineTool<Input, Output>(
  entry: ToolEntry<Input, Output>,
): ToolEntry<Input, Output> {
  return entry;
}

export function isToolHandlerFailure(value: unknown): value is ToolHandlerFailure {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === false;
}
