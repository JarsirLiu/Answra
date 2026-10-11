import { describe, expect, it, vi } from "vitest";
import { configureChromiumCompatibility } from "../src/main/chromiumCompatibility";

describe("Chromium capture compatibility", () => {
  it("sets Chromium's color profile to sRGB on Windows", () => {
    const appendSwitch = vi.fn();
    configureChromiumCompatibility({
      app: { commandLine: { appendSwitch } },
      platform: "win32",
    });

    expect(appendSwitch).toHaveBeenCalledOnce();
    expect(appendSwitch).toHaveBeenCalledWith("force-color-profile", "srgb");
  });

  it("does not change color configuration on other platforms", () => {
    const appendSwitch = vi.fn();
    configureChromiumCompatibility({
      app: { commandLine: { appendSwitch } },
      platform: "darwin",
    });

    expect(appendSwitch).not.toHaveBeenCalled();
  });
});
