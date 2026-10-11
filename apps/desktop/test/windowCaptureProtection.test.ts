import { describe, expect, it, vi } from "vitest";
import {
  isWindowCaptureProtectionSupported,
  setWindowCaptureProtection,
} from "../src/main/windowCaptureProtection";

describe("window capture protection", () => {
  it("supports only Windows 10 build 19041+ and macOS", () => {
    expect(isWindowCaptureProtectionSupported("win32", "10.0.19041")).toBe(true);
    expect(isWindowCaptureProtectionSupported("win32", "10.0.19045")).toBe(true);
    expect(isWindowCaptureProtectionSupported("win32", "10.0.18363")).toBe(false);
    expect(isWindowCaptureProtectionSupported("win32", "invalid")).toBe(false);
    expect(isWindowCaptureProtectionSupported("darwin", "24.0.0")).toBe(true);
    expect(isWindowCaptureProtectionSupported("linux", "6.0.0")).toBe(false);
  });

  it("applies the Electron exclusion flag and reports failures without throwing", () => {
    const window = {
      isContentProtected: vi.fn(() => true),
      setContentProtection: vi.fn(),
    };
    expect(setWindowCaptureProtection(window as never, true)).toBe(true);
    expect(window.setContentProtection).toHaveBeenCalledWith(true);
    expect(window.isContentProtected).toHaveBeenCalledOnce();

    const failedWindow = {
      setContentProtection: vi.fn(() => {
        throw new Error("unsupported");
      }),
    };
    expect(setWindowCaptureProtection(failedWindow as never, true)).toBe(false);
  });

  it("reports a mismatch when Electron does not reflect the requested protection state", () => {
    const window = {
      isContentProtected: vi.fn(() => false),
      setContentProtection: vi.fn(),
    };

    expect(setWindowCaptureProtection(window as never, true)).toBe(false);
  });
});
