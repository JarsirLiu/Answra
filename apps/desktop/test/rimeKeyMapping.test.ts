import { describe, expect, it } from "vitest";
import { rimeKeyCode, rimeKeyMask } from "../src/main/ime/rimeKeyMapping";

describe("Rime keyboard event mapping", () => {
  it("maps physical left and right Shift on Windows and macOS alike", () => {
    expect(rimeKeyCode({ key: "Shift", code: "ShiftLeft" })).toBe(0xffe1);
    expect(rimeKeyCode({ key: "Shift", code: "ShiftRight" })).toBe(0xffe2);
  });

  it("preserves the Rime release bit for modifier keyup events", () => {
    expect(rimeKeyMask({ shift: false, ctrl: false, alt: false, meta: false, release: true })).toBe(
      1 << 30,
    );
  });

  it("combines modifier and release masks", () => {
    expect(rimeKeyMask({ shift: true, ctrl: true, alt: false, meta: false, release: true })).toBe(
      (1 << 30) | 3,
    );
  });
});
