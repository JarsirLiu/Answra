/** 内置工具的静态 ID；只放 ID，import 方不得借此获取工具实现。 */
import { toolId } from "./contracts";

export const READ_TOOL_ID = toolId("workspace.read");
export const GREP_TOOL_ID = toolId("workspace.grep");
export const EDIT_TOOL_ID = toolId("workspace.edit");
export const RUN_COMMAND_TOOL_ID = toolId("workspace.run-command");
export const SKILL_TOOL_ID = toolId("skill.load");
