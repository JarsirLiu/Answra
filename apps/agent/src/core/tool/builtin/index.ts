/** 通用 Agent 工具的唯一装配入口：组合根只调用这里注册内置工具。 */
import type { SkillCatalog } from "../../skill/catalog";
import type { ToolWorkerPaths } from "../contracts";
import { ToolRegistry } from "../registry";
import { editTool } from "./edit/tool";
import { grepTool } from "./grep/tool";
import { readTool } from "./read/tool";
import { createShellTools } from "./runCommand/tool";
import { createSkillTool } from "./skill/tool";

export function createBuiltinToolRegistry(
  options: { readonly workerPaths?: ToolWorkerPaths; readonly skills?: SkillCatalog } = {},
): ToolRegistry {
  const registry = new ToolRegistry({
    ...(options.workerPaths ? { workerPaths: options.workerPaths } : {}),
  });
  const shell = createShellTools();
  registry.register(readTool);
  registry.register(grepTool);
  registry.register(editTool);
  registry.register(shell.runCommand);
  // 无 catalog 时不注册 Skill 工具：宁可"没有 skill 可用"，也不猜目录。
  if (options.skills) registry.register(createSkillTool(options.skills));
  return registry;
}
