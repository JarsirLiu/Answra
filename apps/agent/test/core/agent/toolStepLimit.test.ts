import { describe, expect, it } from "vitest";
import {
  createToolStepLimit,
  MAX_STEPS_PROMPT,
  MAX_TOOL_STEPS,
} from "../../../src/core/agent/toolStepLimit";

describe("conversation tool step limit", () => {
  it("injects the final summary prompt at the project step limit", async () => {
    const { prepareStep } = createToolStepLimit();
    const messages = [{ role: "user" as const, content: "读取文件" }];

    const intermediate = await prepareStep({
      stepNumber: MAX_TOOL_STEPS - 1,
      messages,
    } as never);
    expect(intermediate).toBeUndefined();

    const last = await prepareStep({ stepNumber: MAX_TOOL_STEPS, messages } as never);
    expect(last).toEqual({
      toolChoice: "none",
      messages: [...messages, { role: "assistant", content: MAX_STEPS_PROMPT }],
    });
  });
});
