import { describe, expect, it, vi } from "vitest";
import {
  attachNonActivatingWindow,
  isNonActivatingPlatform,
  isNonActivatingWindow,
} from "../src/main/windowInteractionPolicy";

function createWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    setFocusable: vi.fn(),
    on: vi.fn(),
  };
}

describe("window interaction policy", () => {
  it("only enables non-activating windows on Windows", () => {
    expect(isNonActivatingPlatform("win32")).toBe(true);
    expect(isNonActivatingPlatform("darwin")).toBe(false);
    expect(isNonActivatingPlatform("linux")).toBe(false);
  });

  it("makes a mouse-only surface non-activating and reasserts it on lifecycle events", () => {
    const window = createWindow();

    expect(attachNonActivatingWindow(window, {}, "win32")).toEqual({
      applied: true,
      reason: "applied",
    });
    expect(window.setFocusable).toHaveBeenCalledWith(false);
    expect(window.on).toHaveBeenCalledWith("blur", expect.any(Function));
    expect(window.on).toHaveBeenCalledWith("hide", expect.any(Function));
    expect(isNonActivatingWindow(window)).toBe(true);
  });

  it("keeps a text surface focusable when its keyboard channel is unavailable", () => {
    const window = createWindow();

    expect(
      attachNonActivatingWindow(
        window,
        { requiresKeyboardChannel: true, keyboardChannelAvailable: false },
        "win32",
      ),
    ).toEqual({ applied: false, reason: "keyboard-channel-required" });
    expect(window.setFocusable).not.toHaveBeenCalled();
    expect(isNonActivatingWindow(window)).toBe(false);
  });

  it("does not modify destroyed or unsupported windows", () => {
    const destroyed = createWindow();
    destroyed.isDestroyed.mockReturnValue(true);
    expect(attachNonActivatingWindow(destroyed, {}, "win32").reason).toBe("destroyed");

    const macWindow = createWindow();
    expect(attachNonActivatingWindow(macWindow, {}, "darwin").reason).toBe("unsupported-platform");
    expect(macWindow.setFocusable).not.toHaveBeenCalled();
  });
});
