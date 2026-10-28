import { beforeEach, describe, expect, it, vi } from "vitest";

const protection = vi.hoisted(() => ({
  supported: vi.fn(() => true),
  set: vi.fn(() => true),
  diagnostics: vi.fn(() => ({ reportedProtected: true })),
}));

vi.mock("electron", () => ({ app: { dock: { hide: vi.fn(), show: vi.fn() } } }));
vi.mock("../src/main/windowCaptureProtection", () => ({
  isWindowCaptureProtectionSupported: protection.supported,
  setWindowCaptureProtection: protection.set,
  getWindowCaptureDiagnostics: protection.diagnostics,
}));

import { createWindowStealthController } from "../src/main/windowStealthController";

describe("window stealth controller", () => {
  const window = {
    id: 1,
    isDestroyed: () => false,
    setSkipTaskbar: vi.fn(),
    blur: vi.fn(),
  };
  const host = {
    getMainWindow: () => window,
    applyWindowPolicies: vi.fn(() => true),
    refreshWindowPolicies: vi.fn(() => true),
  };

  beforeEach(() => {
    protection.set.mockClear();
    host.applyWindowPolicies.mockClear();
    window.setSkipTaskbar.mockClear();
  });

  it("applies main and reply surface protection together", () => {
    const controller = createWindowStealthController(host as never);
    controller.apply(true);
    expect(host.applyWindowPolicies).toHaveBeenCalledWith(true);
    expect(protection.set).not.toHaveBeenCalled();
    expect(window.setSkipTaskbar).toHaveBeenCalledWith(true);
  });

  it("refreshes only while enabled", () => {
    const controller = createWindowStealthController(host as never);
    controller.refresh();
    expect(protection.set).not.toHaveBeenCalled();
    controller.apply(true);
    protection.set.mockClear();
    controller.refresh();
    expect(host.refreshWindowPolicies).toHaveBeenCalledWith("window-restore");
  });

  it("restores normal window focus policies when stealth is turned off", () => {
    const controller = createWindowStealthController(host as never);
    controller.apply(false);
    expect(host.applyWindowPolicies).toHaveBeenCalledWith(false);
    expect(window.setSkipTaskbar).toHaveBeenCalledWith(false);
  });
});
