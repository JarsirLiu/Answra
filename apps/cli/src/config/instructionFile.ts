/** CLI 宿主的全局 AGENTS.md 路径解析；agent 不认识配置目录。 */
import { join } from "node:path";
import { resolveDefaultConfigDir } from "@answra/config";

const GLOBAL_INSTRUCTION_FILE = "AGENTS.md";

export function resolveCliInstructionFile(): string {
  return join(resolveDefaultConfigDir(), GLOBAL_INSTRUCTION_FILE);
}
