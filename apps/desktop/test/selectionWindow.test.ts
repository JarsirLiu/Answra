import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  windows: [] as Array<{
    close: ReturnType<typeof vi.fn>;
    loadFile: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
    setAlwaysOnTop: ReturnType<typeof vi.fn>;
    setFocusable: ReturnType<typeof vi.fn>;
    setContentProtection: ReturnType<typeof vi.fn>;
    isDestroyed: ReturnType<typeof vi.fn>;
    showInactive: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("electron", () => ({
  BrowserWindow: class {
    close = vi.fn();
    loadFile = vi.fn();
    once = vi.fn();
    setAlwaysOnTop = vi.fn();
    setFocusable = vi.fn();
    setContentProtection = vi.fn();
    isDestroyed = vi.fn(() => false);
    showInactive = vi.fn();
    on = vi.fn();

    constructor() {
      state.windows.push(this);
    }
  },
  screen: {
    getAllDisplays: () => [{ bounds: { height: 1080, width: 1920, x: 0, y: 0 }, id: 1 }],
  },
}));

import { createSelectionWindows } from "../src/main/capture/selectionWindow";
import { createWindowSurfaceRegistry } from "../src/main/windowSurfaceRegistry";

describe("selectionWindow capture protection", () => {
  beforeEach(() => {
    state.windows.length = 0;
  });

  function createPolicyHost(stealth: boolean) {
    const registry = createWindowSurfaceRegistry({
      applyCaptureProtection: (window, enabled) => {
        window.setContentProtection(enabled);
        return true;
      },
    });
    registry.setStealthEnabled(stealth);
    return {
      registerWindowSurface: registry.register,
      prepareWindowToShow: registry.prepareToShow,
    };
  }

  it("does not alter system capture behavior when meeting stealth is off", () => {
    createSelectionWindows("#ffffff", false, createPolicyHost(false));

    expect(state.windows).toHaveLength(1);
    expect(state.windows[0].setContentProtection).toHaveBeenCalledWith(false);
  });

  it("excludes the selection overlay while meeting stealth is on", () => {
    createSelectionWindows("#ffffff", true, createPolicyHost(true));

    expect(state.windows).toHaveLength(1);
    expect(state.windows[0].setContentProtection).toHaveBeenCalledWith(true);
    expect(state.windows[0].loadFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ query: expect.objectContaining({ stealth: "true" }) }),
    );
  });
});
