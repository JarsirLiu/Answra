/** 工具启动期静态注册表：注册、查询、按授权 id 生成 AI SDK ToolSet。 */
import { jsonSchema, type ToolSet, tool } from "ai";
import type { AnyToolEntry, ReadFileStateMap, ToolEntry, ToolId } from "./contracts";
import { executeToolCall } from "./executor/executeToolCall";
import { ToolExecutionError } from "./executor/result";

export interface ToolSessionContext {
  readonly signal: AbortSignal;
  readonly workspaceRoot: string | null;
  readonly runId: string;
  readonly sessionId: string;
  readonly readFileState?: ReadFileStateMap;
}

export class ToolRegistry {
  private readonly entries = new Map<ToolId, AnyToolEntry>();

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
    for (const id of ids) {
      const entry = this.require(id);
      if (tools[entry.metadata.name]) throw new Error(`工具名重复：${entry.metadata.name}`);
      tools[entry.metadata.name] = createModelTool(entry, context);
    }
    return tools;
  }
}

function createModelTool(entry: AnyToolEntry, context: ToolSessionContext) {
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
      });
      if (!result.success) throw new ToolExecutionError(result.error.code, result.error.message);
      return result.modelContent;
    },
  });
}
