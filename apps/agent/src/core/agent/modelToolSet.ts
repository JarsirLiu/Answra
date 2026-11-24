/** AI SDK 工具声明投影：保留 schema 与 metadata，移除 SDK 对本地工具的执行权。 */
import type { ToolSet } from "ai";

export function modelToolSet(tools: ToolSet | undefined): ToolSet | undefined {
  if (tools === undefined) return undefined;

  const definitions: ToolSet = {};
  for (const [name, definition] of Object.entries(tools)) {
    const { execute, ...modelDefinition } = definition;
    void execute;
    definitions[name] = modelDefinition;
  }
  return definitions;
}
