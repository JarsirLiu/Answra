import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  displays: [{ bounds: { height: 1080, width: 1920, x: 0, y: 0 }, id: 1 }] as Array<{
    bounds: { height: number; width: number; x: number; y: number };
    id: number;
  }>,
  cursor: { x: 640, y: 360 },
  windows: [] as Array<{
    close: ReturnType<typeof vi.fn>;
    hide: ReturnType<typeof vi.fn>;
    loadFile: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
    setBounds: ReturnType<typeof vi.fn>;
    setAlwaysOnTop: ReturnType<typeof vi.fn>;
    setFocusable: ReturnType<typeof vi.fn>;
    setContentProtection: ReturnType<typeof vi.fn>;
    setIgnoreMouseEvents: ReturnType<typeof vi.fn>;
    setOpacity: ReturnType<typeof vi.fn>;
    isDestroyed: ReturnType<typeof vi.fn>;
    showInactive: ReturnType<typeof vi.fn>;
    moveTop: ReturnType<typeof vi.fn>;
    options: Record<string, unknown>;
  }>,
}));

vi.mock("electron", () => ({
  app: { on: vi.fn() },
  BrowserWindow: class {
    static getFocusedWindow = vi.fn(() => undefined);
    id = state.windows.length + 1;
    close = vi.fn();
    hide = vi.fn();
    loadFile = vi.fn(() => Promise.resolve());
    once = vi.fn();
    setBounds = vi.fn();
    setAlwaysOnTop = vi.fn();
    setFocusable = vi.fn();
    setContentProtection = vi.fn();
    setIgnoreMouseEvents = vi.fn();
    setOpacity = vi.fn();
    isDestroyed = vi.fn(() => false);
    isFocusable = vi.fn(() => false);
    isFocused = vi.fn(() => false);
    showInactive = vi.fn();
    moveTop = vi.fn();
    on = vi.fn();
    options: Record<string, unknown>;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      state.windows.push(this);
    }
  },
  screen: {
    getAllDisplays: () => state.displays,
    getCursorScreenPoint: () => state.cursor,
  },
}));

import {
  createSelectionWindows,
  disposeSelectionWindow,
  getActiveSelectionWindows,
  hideSelectionWindows,
  parkSelectionWindowsForReuse,
} from "../src/main/capture/selectionWindow";
import { createWindowSurfaceRegistry } from "../src/main/windowSurfaceRegistry";

describe("selectionWindow capture protection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    disposeSelectionWindow();
    state.windows.length = 0;
    state.displays = [{ bounds: { height: 1080, width: 1920, x: 0, y: 0 }, id: 1 }];
    state.cursor = { x: 640, y: 360 };
  });

  afterEach(() => {
    vi.useRealTimers();
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
      prepareCaptureProtection: registry.prepareCaptureProtection,
      onFocusSnapshot: vi.fn(),
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

  it("shows the Windows selection overlay with Natively's non-activating opacity shield", async () => {
    const host = createPolicyHost(false);
    createSelectionWindows("#ffffff", false, host, "win32");

    const window = state.windows[0];
    expect(window.options).toMatchObject({ alwaysOnTop: true, focusable: false });
    await Promise.resolve();

    expect(window.setOpacity).toHaveBeenNthCalledWith(1, 0);
    expect(window.showInactive).toHaveBeenCalledOnce();
    expect(window.moveTop).toHaveBeenCalledOnce();
    expect(window.setContentProtection.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      window.moveTop.mock.invocationCallOrder[0],
    );
    expect(window.setOpacity).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60);
    expect(window.setOpacity).toHaveBeenLastCalledWith(1);
  });

  it("hides and reuses the overlay after selection instead of closing its native window", async () => {
    const host = createPolicyHost(false);
    createSelectionWindows(undefined, false, host, "win32");
    const window = state.windows[0];
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(60);

    hideSelectionWindows();
    expect(window.hide).toHaveBeenCalledOnce();
    expect(window.close).not.toHaveBeenCalled();
    expect(getActiveSelectionWindows()).toEqual([]);

    createSelectionWindows("#ffffff", false, host, "win32");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(60);

    expect(state.windows).toHaveLength(1);
    expect(state.windows[0]).toBe(window);
    expect(window.loadFile).toHaveBeenCalledTimes(2);
    expect(window.showInactive).toHaveBeenCalledTimes(2);
    expect(window.setBounds).toHaveBeenCalledOnce();
  });

  it("parks the Windows overlay click-through and restores it for the next selection", async () => {
    const host = createPolicyHost(false);
    createSelectionWindows(undefined, false, host, "win32");
    const window = state.windows[0];
    await Promise.resolve();

    parkSelectionWindowsForReuse();

    expect(window.setOpacity).toHaveBeenLastCalledWith(0);
    expect(window.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true);
    expect(window.setAlwaysOnTop).not.toHaveBeenCalledWith(false);
    expect(window.hide).not.toHaveBeenCalled();
    expect(getActiveSelectionWindows()).toEqual([]);

    createSelectionWindows(undefined, false, host, "win32");
    await Promise.resolve();

    expect(window.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
    expect(window.setOpacity).toHaveBeenLastCalledWith(0);
    expect(getActiveSelectionWindows()).toEqual([window]);
  });

  it("creates one overlay spanning the virtual desktop including negative display origins", () => {
    state.displays = [
      { bounds: { height: 1080, width: 1920, x: -1920, y: 0 }, id: 1 },
      { bounds: { height: 1200, width: 1920, x: 0, y: -60 }, id: 2 },
    ];

    createSelectionWindows(undefined, false, createPolicyHost(false));

    expect(state.windows).toHaveLength(1);
    expect(state.windows[0].options).toMatchObject({
      x: -1920,
      y: -60,
      width: 3840,
      height: 1200,
    });
    expect(state.windows[0].loadFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        query: expect.objectContaining({ originX: "-1920", originY: "-60" }),
      }),
    );
    const query = state.windows[0].loadFile.mock.calls[0][1].query;
    expect(JSON.parse(query.displays)).toEqual([
      { id: 1, x: -1920, y: 0, width: 1920, height: 1080 },
      { id: 2, x: 0, y: -60, width: 1920, height: 1200 },
    ]);
    expect(query).not.toHaveProperty("hintX");
    expect(query).not.toHaveProperty("hintY");
  });
});
