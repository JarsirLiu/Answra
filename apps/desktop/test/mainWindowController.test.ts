import { beforeEach, describe, expect, it, vi } from "vitest";

const electronState = vi.hoisted(() => ({
  windows: [] as Array<{
    emit: (event: string) => boolean;
    show: ReturnType<typeof vi.fn>;
    showInactive: ReturnType<typeof vi.fn>;
    options: Record<string, unknown>;
    isFocusable: ReturnType<typeof vi.fn>;
    setFocusable: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("electron", async () => {
  const { EventEmitter: MockEventEmitter } = await import("node:events");
  class MockBrowserWindow extends MockEventEmitter {
    static getFocusedWindow = vi.fn(() => undefined);
    id = 1;
    webContents = Object.assign(new MockEventEmitter(), {
      setWindowOpenHandler: vi.fn(),
    });
    show = vi.fn();
    showInactive = vi.fn();
    options: Record<string, unknown>;
    loadFile = vi.fn();
    loadURL = vi.fn();
    getBounds = vi.fn(() => ({ x: 0, y: 0, width: 340, height: 60 }));
    isDestroyed = vi.fn(() => false);
    isVisible = vi.fn(() => true);
    isFocused = vi.fn(() => false);
    isFocusable = vi.fn(() => false);
    setBounds = vi.fn();
    setFocusable = vi.fn();

    constructor(options: Record<string, unknown>) {
      super();
      this.options = options;
      electronState.windows.push(this);
    }
  }

  return {
    app: { isPackaged: false },
    BrowserWindow: MockBrowserWindow,
    screen: {
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 800 } }),
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 800 } }),
    },
  };
});

vi.mock("../src/main/ime/imeDiagnostics", () => ({ logImeDiagnostic: vi.fn() }));
vi.mock("../src/main/windowForeground", () => ({
  describeForegroundWindow: vi.fn(() => ({})),
  isCurrentProcessForeground: vi.fn(() => false),
}));

import { createMainWindowController } from "../src/main/mainWindowController";

describe("main window initial display", () => {
  beforeEach(() => {
    electronState.windows = [];
  });

  it("shows the first window without activating it", () => {
    const controller = createMainWindowController({
      registerWindowSurface: vi.fn(),
      prepareWindowToShow: vi.fn(() => true),
      onClosed: vi.fn(),
    });

    const window = controller.create();
    window.emit("ready-to-show");

    expect(window.showInactive).toHaveBeenCalledOnce();
    expect(window.show).not.toHaveBeenCalled();
    expect(electronState.windows[0].options.focusable).toBe(
      process.platform === "win32" ? false : undefined,
    );
  });

  it("keeps the window hidden when its registered surface is not ready", () => {
    const controller = createMainWindowController({
      registerWindowSurface: vi.fn(),
      prepareWindowToShow: vi.fn(() => false),
      onClosed: vi.fn(),
    });

    const window = controller.create();
    window.emit("ready-to-show");

    expect(window.showInactive).not.toHaveBeenCalled();
    expect(window.show).not.toHaveBeenCalled();
  });
});
