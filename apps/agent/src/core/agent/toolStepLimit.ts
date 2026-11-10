/** Agent 工具循环上限：保留有限工具步数，并在最后一步强制文本收尾。 */
import { type PrepareStepFunction, type StopCondition, stepCountIs, type ToolSet } from "ai";

/** 允许模型发起工具调用的最大步数；最后额外保留一次纯文本总结。 */
export const MAX_TOOL_STEPS = 20;

export const MAX_STEPS_PROMPT = [
  "工具调用步数已达到上限。",
  "不要再调用任何工具。",
  "请只输出文本：总结已经完成的工作、尚未完成的事项，以及建议的下一步。",
].join("\n");

export function createToolStepLimit(): {
  stopWhen: StopCondition<ToolSet>;
  prepareStep: PrepareStepFunction<ToolSet>;
} {
  return {
    stopWhen: stepCountIs(MAX_TOOL_STEPS + 1),
    prepareStep: ({ stepNumber, messages }) => {
      if (stepNumber < MAX_TOOL_STEPS) return undefined;
      return {
        toolChoice: "none",
        messages: [...messages, { role: "assistant", content: MAX_STEPS_PROMPT }],
      };
    },
  };
}
