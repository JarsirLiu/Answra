import { describe, expect, it } from "vitest";
import { isNonActivatingPlatform } from "../src/main/windowInteractionPolicy";

describe("window interaction platform capabilities", () => {
  it("limits the non-activating native style to Windows", () => {
    expect(isNonActivatingPlatform("win32")).toBe(true);
    expect(isNonActivatingPlatform("darwin")).toBe(false);
    expect(isNonActivatingPlatform("linux")).toBe(false);
  });
});
