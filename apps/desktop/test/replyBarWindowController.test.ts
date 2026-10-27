import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  moveListener: undefined as (() => void) | undefined,
  replyWindow: undefined as Record<string, unknown> | undefined,
  workArea: { x: 0, y: 0, width: 800, height: 600 },
}));

vi.mock("electron", () => ({
  app: { isPackaged: true },
  BrowserWindow: vi.fn(function (this: object) {
    return mocks.replyWindow ?? this;
  }),
  screen: {
    getDisplayMatching: vi.fn(() => ({ workArea: mocks.workArea })),
  },
}));

vi.mock("../src/main/windowCaptureProtection", () => ({
  setWindowCaptureProtection: vi.fn(() => true),
}));

vi.mock("../src/main/windowStealthController", () => ({
  isolateNativeIme: vi.fn(() => "applied"),
  restoreNativeIme: vi.fn(() => "applied"),
}));

import { createReplyBarWindowController } from "../src/main/replyBarWindowController";
import { isolateNativeIme, restoreNativeIme } from "../src/main/windowStealthController";

function createReplyWindow(): Record<string, unknown> {
  let bounds = { x: 100, y: 200, width: 480, height: 76 };
  return {
    close: vi.fn(),
    getBounds: vi.fn(() => bounds),
    isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => false),
    loadFile: vi.fn(),
    on: vi.fn((event: string, listener: () => void) => {
      if (event === "move") mocks.moveListener = listener;
    }),
    once: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    setBounds: vi.fn((nextBounds: typeof bounds) => {
      bounds = nextBounds;
    }),
    setPosition: vi.fn((x: number, y: number) => {
      bounds = { ...bounds, x, y };
    }),
    setSkipTaskbar: vi.fn(),
    showInactive: vi.fn(),
    webContents: {
      on: vi.fn(),
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    },
  };
}

describe("reply bar window lifecycle", () => {
  beforeEach(() => {
    mocks.replyWindow = createReplyWindow();
    mocks.moveListener = undefined;
    vi.mocked(isolateNativeIme).mockClear();
    vi.mocked(restoreNativeIme).mockClear();
  });

  it("syncs every streamed state but only logs actual main-window visibility changes", () => {
    let mainVisible = true;
    const mainWindow = {
      getBounds: () => ({ x: 0, y: 0, width: 400, height: 48 }),
      hide: vi.fn(() => {
        mainVisible = false;
      }),
      isDestroyed: vi.fn(() => false),
      isVisible: vi.fn(() => mainVisible),
      showInactive: vi.fn(() => {
        mainVisible = true;
      }),
    };
    const logCaptureSurfaceState = vi.fn();
    const controller = createReplyBarWindowController({
      getMainWindow: () => mainWindow as never,
      registerWindowSurface: vi.fn(),
      prepareWindowToShow: () => true,
      logCaptureSurfaceState,
      sendReplyBarAction: vi.fn(),
    });
    const firstState = { phase: "streaming" } as never;
    const nextState = { phase: "streaming", replyText: "new token" } as never;

    controller.setState(firstState);
    controller.setState(nextState);
    expect(mainWindow.hide).toHaveBeenCalledOnce();
    expect(logCaptureSurfaceState).toHaveBeenCalledExactlyOnceWith(
      "reply-bar-opened-main-hidden",
      mainWindow,
    );
    const replyWindow = mocks.replyWindow as {
      webContents: { send: ReturnType<typeof vi.fn> };
    };
    expect(replyWindow.webContents.send).toHaveBeenCalledWith(expect.any(String), nextState);

    controller.setState(null);
    controller.setState(null);
    expect(mainWindow.showInactive).toHaveBeenCalledOnce();
    expect(logCaptureSurfaceState).toHaveBeenCalledTimes(2);
    expect(logCaptureSurfaceState).toHaveBeenLastCalledWith("reply-bar-closed", mainWindow);
  });

  it("switches the reply surface between embedded and system input with stealth", () => {
    const mainWindow = {
      getBounds: () => ({ x: 0, y: 0, width: 400, height: 48 }),
      hide: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isVisible: vi.fn(() => true),
      showInactive: vi.fn(),
    };
    const controller = createReplyBarWindowController({
      getMainWindow: () => mainWindow as never,
      registerWindowSurface: vi.fn(),
      prepareWindowToShow: () => true,
      logCaptureSurfaceState: vi.fn(),
      sendReplyBarAction: vi.fn(),
    });

    controller.setState({ phase: "composing", stealth: true } as never);
    expect(isolateNativeIme).toHaveBeenCalledWith(mocks.replyWindow);
    expect(restoreNativeIme).not.toHaveBeenCalled();

    vi.mocked(isolateNativeIme).mockClear();
    controller.setState({ phase: "composing", stealth: false } as never);
    expect(restoreNativeIme).toHaveBeenCalledWith(mocks.replyWindow);
    expect(isolateNativeIme).not.toHaveBeenCalled();
  });

  it("tracks dragged position and clamps the window before a later resize", () => {
    const mainWindow = {
      getBounds: () => ({ x: 100, y: 200, width: 400, height: 48 }),
      hide: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isVisible: vi.fn(() => true),
      showInactive: vi.fn(),
    };
    const controller = createReplyBarWindowController({
      getMainWindow: () => mainWindow as never,
      registerWindowSurface: vi.fn(),
      prepareWindowToShow: () => true,
      logCaptureSurfaceState: vi.fn(),
      sendReplyBarAction: vi.fn(),
    });
    controller.setState({ phase: "composing" } as never);

    const replyWindow = mocks.replyWindow as {
      getBounds: ReturnType<typeof vi.fn>;
      setBounds: ReturnType<typeof vi.fn>;
      setPosition: ReturnType<typeof vi.fn>;
    };
    replyWindow.getBounds.mockReturnValue({ x: -10, y: 20, width: 480, height: 76 });
    mocks.moveListener?.();
    expect(replyWindow.setPosition).toHaveBeenCalledWith(0, 20, false);

    controller.resize({ width: 560, height: 400 });
    expect(replyWindow.setBounds).toHaveBeenCalledWith(
      { x: 0, y: 20, width: 560, height: 400 },
      false,
    );
  });
});
