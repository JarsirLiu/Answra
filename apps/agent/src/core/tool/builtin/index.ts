/** 通用 Agent 工具的唯一装配入口：组合根只调用这里注册内置工具。 */
import { ToolRegistry } from "../registry";
import { grepTool } from "./grep";
import { readTool } from "./read";

export function createBuiltinToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(readTool);
  registry.register(grepTool);
  return registry;
}
