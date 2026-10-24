import { describe, expect, it } from "vitest";

import { applyModeAvailability, MODES } from "../src/model";

describe("applyModeAvailability", () => {
  it("缺省可用：模式定义原样透传", () => {
    expect(applyModeAvailability(MODES, {})).toEqual(MODES);
    expect(applyModeAvailability(MODES, { interview: true })).toEqual(MODES);
  });

  it("面试不可用：动作替换为「暂不支持」禁用入口，其他模式不变", () => {
    const modes = applyModeAvailability(MODES, { interview: false });
    const interview = modes.find((mode) => mode.id === "interview");
    expect(interview?.actions).toHaveLength(1);
    const action = interview?.actions[0];
    expect(action?.disabled).toBe(true);
    expect(action?.label).toContain("暂不支持");
    expect(action?.hint).toBeTruthy();
    // 其他模式不受影响
    const exam = modes.find((mode) => mode.id === "exam");
    expect(exam).toEqual(MODES.find((mode) => mode.id === "exam"));
  });
});
