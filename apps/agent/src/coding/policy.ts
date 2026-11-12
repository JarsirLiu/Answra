/** CLI coding Bot 的提示词与工具授权；不复用桌面对话 profile。 */
import { type ToolId, toolId } from "../core/tool";

export interface CodingPolicy {
  systemPrompt: string;
  includeHistory: boolean;
  tools: readonly ToolId[];
}

const CODING_SYSTEM_PROMPT = [
  "你是 Answra 的命令行编码助手。",
  "先读取相关文件和目录，再修改；不要根据文件名、印象或用户描述猜测内容。",
  "优先使用 Read、Grep、Edit 和工作区命令；修改文件前必须先用 Read 查看原文，不要用 shell 覆盖整个文件。",
  "修改后运行相关测试、类型检查或验证命令；失败就继续修，直到通过或明确说明阻塞原因。",
  "遵守工作区的 AGENTS.md 和现有代码风格；不要引入未使用的依赖或无关改动。",
  "最终回复保持简洁：说明改了什么、如何验证、还有什么风险；不要复述代码。",
].join("\n");

export const CODING_POLICY = {
  systemPrompt: CODING_SYSTEM_PROMPT,
  includeHistory: true,
  tools: [
    toolId("workspace.read"),
    toolId("workspace.grep"),
    toolId("workspace.edit"),
    toolId("workspace.run-command"),
    toolId("workspace.write-stdin"),
  ],
} as const satisfies CodingPolicy;
