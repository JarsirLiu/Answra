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
    execute: async (input: unknown, options): Promise<string> => {
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
      });
      return result.modelContent;
    },
  });
}
