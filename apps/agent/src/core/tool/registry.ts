/** 工具启动期静态注册表：注册、查询、按授权 id 生成 AI SDK ToolSet。 */
import { jsonSchema, type ToolSet, tool } from "ai";
import type {
  AnyToolEntry,
  ReadFileStateMap,
  ToolEntry,
  ToolId,
  ToolWorkerPaths,
} from "./contracts";
import { executeToolCall } from "./executor/executeToolCall";

export interface ToolSessionContext {
  readonly signal: AbortSignal;
  readonly workspaceRoot: string | null;
  readonly runId: string;
  readonly sessionId: string;
  readonly readFileState?: ReadFileStateMap;
  readonly workerPaths?: ToolWorkerPaths;
  /** 单次工具调用的增量输出回调；由 Agent 层接到事件日志。 */
  readonly onToolOutput?: (toolCallId: string, delta: string) => void;
}

export interface ToolRegistryOptions {
  readonly workerPaths?: ToolWorkerPaths;
}

export class ToolRegistry {
  private readonly entries = new Map<ToolId, AnyToolEntry>();
  private readonly workerPaths: ToolWorkerPaths | undefined;

  constructor(options: ToolRegistryOptions = {}) {
    this.workerPaths = options.workerPaths;
  }

  register<Input, Output>(entry: ToolEntry<Input, Output>): void {
    if (this.entries.has(entry.id)) throw new Error(`工具已注册：${entry.id}`);
    this.entries.set(entry.id, entry);
  }

  list(): readonly AnyToolEntry[] {
    return [...this.entries.values()];
  }

  require(id: ToolId): AnyToolEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`工具未注册：${id}`);
    return entry;
  }

  /** 关闭注册表并释放工具持有的进程、会话等长生命周期资源。 */
  async dispose(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map((entry) => entry.dispose?.()));
  }

  authorize(ids: readonly ToolId[], context: ToolSessionContext): ToolSet {
    const tools: ToolSet = {};
    const workerPaths = context.workerPaths ?? this.workerPaths;
    for (const id of ids) {
      const entry = this.require(id);
      if (tools[entry.metadata.name]) throw new Error(`工具名重复：${entry.metadata.name}`);
      tools[entry.metadata.name] = createModelTool(entry, context, workerPaths);
    }
    return tools;
  }
}

function createModelTool(
  entry: AnyToolEntry,
  context: ToolSessionContext,
  workerPaths: ToolWorkerPaths | undefined,
) {
  return tool({
    description: entry.metadata.description,
    inputSchema: jsonSchema(entry.inputSchema),
    execute: async (input: unknown, options): Promise<unknown> => {
      const result = await executeToolCall(entry, input, {
        toolCallId: options.toolCallId,
        signal: options.abortSignal
          ? AbortSignal.any([context.signal, options.abortSignal])
          : context.signal,
        workspaceRoot: context.workspaceRoot,
        runId: context.runId,
        sessionId: context.sessionId,
        ...(context.readFileState ? { readFileState: context.readFileState } : {}),
        ...(workerPaths ? { workerPaths } : {}),
        ...(context.onToolOutput
          ? {
              onOutput: (delta: string) => {
                context.onToolOutput?.(options.toolCallId, delta);
              },
            }
          : {}),
      });
      return result.success && entry.exposeOutput ? result.output : result.modelContent;
    },
    toModelOutput: ({ output }) => ({ type: "text", value: modelOutput(entry, output) }),
  });
}

function modelOutput(entry: AnyToolEntry, output: unknown): string {
  if (typeof output === "string") return output;
  return entry.formatModelContent?.(output) ?? JSON.stringify(output) ?? String(output);
}
