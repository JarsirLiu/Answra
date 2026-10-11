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
  const window = { id: 1, isDestroyed: () => false, setSkipTaskbar: vi.fn() };
  const host = { getMainWindow: () => window, setReplyBarProtection: vi.fn() };

  beforeEach(() => {
    protection.set.mockClear();
    host.setReplyBarProtection.mockClear();
    window.setSkipTaskbar.mockClear();
  });

  it("applies main and reply surface protection together", () => {
    const controller = createWindowStealthController(host as never);
    controller.apply(true);
    expect(protection.set).toHaveBeenCalledWith(window, true);
    expect(host.setReplyBarProtection).toHaveBeenCalledWith(true);
    expect(window.setSkipTaskbar).toHaveBeenCalledWith(true);
  });

  it("refreshes only while enabled", () => {
    const controller = createWindowStealthController(host as never);
    controller.refresh();
    expect(protection.set).not.toHaveBeenCalled();
    controller.apply(true);
    protection.set.mockClear();
    controller.refresh();
    expect(protection.set).toHaveBeenCalledWith(window, true);
  });
});
