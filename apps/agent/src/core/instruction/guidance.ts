/** 把 AGENTS.md 文件渲染成 system prompt 片段；不读盘、不判断来源。 */
import type { InstructionFile } from "./contracts";

const INSTRUCTION_HEADING = "## AGENTS.md";
const INSTRUCTION_PREAMBLE =
  "以下内容来自本地 AGENTS.md，按项目根到当前工作区排序；越靠后的文件越具体，冲突时优先遵守。";

export function renderInstructionContext(files: readonly InstructionFile[]): string {
  if (files.length === 0) return "";
  return [
    INSTRUCTION_HEADING,
    INSTRUCTION_PREAMBLE,
    ...files.map((file) => `Instructions from: ${file.path}\n${file.content}`),
  ].join("\n\n");
}
