import { describe, expect, it } from "vitest";
import {
  createToolStepLimit,
  MAX_STEPS_PROMPT,
  MAX_TOOL_STEPS,
} from "../../../src/conversation/turn/stepLimit";

describe("conversation tool step limit", () => {
  it("stops after the tool steps plus one final answer step", () => {
    const { stopWhen } = createToolStepLimit();
    const steps = (count: number) => Array.from({ length: count }, () => ({}));

    expect(stopWhen({ steps: steps(MAX_TOOL_STEPS) } as never)).toBe(false);
    expect(stopWhen({ steps: steps(MAX_TOOL_STEPS + 1) } as never)).toBe(true);
  });

  it("disables tools and injects the final summary prompt on the last step", async () => {
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
