/** 通用 Agent 工具的唯一装配入口：组合根只调用这里注册内置工具。 */
import type { ToolWorkerPaths } from "../contracts";
import { ToolRegistry } from "../registry";
import { editTool } from "./edit";
import { grepTool } from "./grep";
import { readTool } from "./read";
import { createShellTools } from "./shell/tools";

export function createBuiltinToolRegistry(
  options: { readonly workerPaths?: ToolWorkerPaths } = {},
): ToolRegistry {
  const registry = new ToolRegistry({
    ...(options.workerPaths ? { workerPaths: options.workerPaths } : {}),
  });
  const shell = createShellTools();
  registry.register(readTool);
  registry.register(grepTool);
  registry.register(editTool);
  registry.register(shell.runCommand);
  registry.register(shell.writeStdin);
  return registry;
}
