import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 区域截图 IPC 编排测试：mock electron/ipcMain 与 window、selectionWindow、
 * captureService 依赖，验证 registerCaptureIpc 在“选区落定→捕获→裁剪”各阶段的返回，
 * 以及非法调用方、用户取消、捕获失败的映射。真实 desktopCapturer 行为由 capture.test.ts 覆盖。
 */

const shared = vi.hoisted(() => ({
  fakeOverlay: { once: vi.fn(), webContents: { id: "overlay" } },
  fakeWindow: {
    id: 2,
    hide: vi.fn(() => {
      shared.visible = false;
    }),
    isDestroyed: () => false,
    isFocused: vi.fn(() => false),
    isFocusable: vi.fn(() => false),
    isVisible: vi.fn(() => shared.visible),
    showInactive: vi.fn(() => {
      shared.visible = true;
    }),
    webContents: { id: "main" },
  },
  visible: true,
  replyVisible: false,
  stealthEnabled: false,
  escapeHandler: undefined as (() => void) | undefined,
  handlers: {} as Record<string, (...args: unknown[]) => unknown>,
}));

vi.mock("electron", () => ({
  BrowserWindow: { getFocusedWindow: () => undefined },
  desktopCapturer: { getSources: vi.fn() },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      shared.handlers[channel] = fn;
    },
    on: (channel: string, fn: (...args: unknown[]) => unknown) => {
      shared.handlers[channel] = fn;
    },
  },
  globalShortcut: {
    register: vi.fn((_accelerator: string, callback: () => void) => {
      shared.escapeHandler = callback;
      return true;
    }),
    unregister: vi.fn(() => {
      shared.escapeHandler = undefined;
    }),
  },
  screen: {
    getAllDisplays: () => [],
    getPrimaryDisplay: () => ({
      id: 0,
      size: { height: 1, width: 1 },
      workArea: { height: 1, width: 1, x: 0, y: 0 },
    }),
  },
}));

vi.mock("../src/main/window", () => ({
  getWindow: () => shared.fakeWindow,
  isStealthEnabled: () => shared.stealthEnabled,
  isWindowFromSender: vi.fn(() => true),
  hideReplyBarWindowForCapture: vi.fn(() => {
    const previous = shared.replyVisible;
    shared.replyVisible = false;
    return previous;
  }),
  restoreReplyBarWindowAfterCapture: vi.fn((wasVisible: boolean) => {
    shared.replyVisible = wasVisible;
  }),
  setReplyBarAnchor: vi.fn(),
  refreshStealthCaptureProtection: vi.fn(),
  registerWindowSurface: vi.fn(),
  prepareWindowCaptureProtection: vi.fn(() => true),
  prepareWindowToShow: vi.fn(() => true),
}));

vi.mock("../src/main/capture/selectionWindow", () => ({
  hideSelectionWindows: vi.fn(),
  parkSelectionWindowsForReuse: vi.fn(),
  createSelectionWindows: vi.fn(() => [shared.fakeOverlay]),
  getActiveSelectionWindows: vi.fn(() => [shared.fakeOverlay]),
}));

vi.mock("../src/main/capture/captureService", () => {
  class ScreenCaptureError extends Error {
    reason: string;
    constructor(reason: string, message: string) {
      super(message);
      this.reason = reason;
      this.name = "ScreenCaptureError";
    }
  }
  return {
    ScreenCaptureError,
    captureDisplay: vi.fn(),
    cropToDataUrl: vi.fn(),
  };
});

import { CaptureChannels } from "@answra/shared";
import { registerCaptureIpc } from "../src/main/capture/captureIpc";
import {
  captureDisplay,
  cropToDataUrl,
  ScreenCaptureError,
} from "../src/main/capture/captureService";
import {
  createSelectionWindows,
  hideSelectionWindows,
  parkSelectionWindowsForReuse,
} from "../src/main/capture/selectionWindow";
import { isWindowFromSender, prepareWindowToShow, setReplyBarAnchor } from "../src/main/window";

const VALID_SELECTION = {
  displayId: 1,
  rect: { height: 10, width: 10, x: 0, y: 0 },
  point: { x: 10, y: 10 },
};

describe("captureIpc 区域截图编排", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(shared.handlers)) delete shared.handlers[key];
    vi.mocked(isWindowFromSender).mockReturnValue(true);
    shared.stealthEnabled = false;
    shared.visible = true;
    registerCaptureIpc();
  });

  it("returns ok:true when a region is selected and capture succeeds", async () => {
    vi.mocked(captureDisplay).mockResolvedValue({ image: {}, scaleFactor: 1 });
    vi.mocked(cropToDataUrl).mockReturnValue({
      dataUrl: "data:image/png;base64,QUJD",
      height: 10,
      ok: true,
      width: 10,
    });

    const start = shared.handlers[CaptureChannels.StartRegionCapture]({}, { line: "#ffffff" });
    shared.handlers[CaptureChannels.RegionSelected](
      { sender: shared.fakeOverlay.webContents },
      VALID_SELECTION,
    );
    const result = (await start) as { ok: boolean; reason?: string };

    expect(result.ok).toBe(true);
    expect(createSelectionWindows).toHaveBeenCalledWith("#ffffff", false, expect.any(Object));
    expect(captureDisplay).toHaveBeenCalledWith(1);
    expect(shared.fakeWindow.hide.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(captureDisplay).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(captureDisplay).mock.invocationCallOrder[0]).toBeLessThan(
      shared.fakeWindow.showInactive.mock.invocationCallOrder[0],
    );
    expect(shared.fakeWindow.isVisible()).toBe(true);
    expect(cropToDataUrl).toHaveBeenCalled();
    // 专注发送态：选区落定后窗口挪到选区旁（原位已记录，收起时恢复）
    expect(setReplyBarAnchor).toHaveBeenCalledWith(VALID_SELECTION);
  });

  it("passes active stealth state to the selection overlay", async () => {
    shared.stealthEnabled = true;
    const start = shared.handlers[CaptureChannels.StartRegionCapture]({}, {});
    shared.handlers[CaptureChannels.RegionCancelled]({ sender: shared.fakeOverlay.webContents });
    await start;

    expect(createSelectionWindows).toHaveBeenCalledWith(undefined, true, expect.any(Object));
  });

  it.skipIf(process.platform !== "win32")(
    "registers Escape for the active Windows capture and unregisters after cancellation",
    async () => {
      const { globalShortcut } = await import("electron");
      const start = shared.handlers[CaptureChannels.StartRegionCapture]({}, {});
      expect(globalShortcut.register).toHaveBeenCalledWith("Escape", expect.any(Function));

      shared.escapeHandler?.();
      const result = await start;

      expect(result).toEqual({ ok: false, reason: "cancelled" });
      expect(globalShortcut.unregister).toHaveBeenCalledWith("Escape");
    },
  );

  it("keeps the protected Windows main window visible during capture", async () => {
    shared.stealthEnabled = true;
    vi.mocked(captureDisplay).mockImplementation(async () => {
      expect(shared.fakeWindow.isVisible()).toBe(process.platform === "win32");
      return { image: {}, scaleFactor: 1 };
    });
    vi.mocked(cropToDataUrl).mockReturnValue({
      dataUrl: "data:image/png;base64,QUJD",
      height: 10,
      ok: true,
      width: 10,
    });

    const start = shared.handlers[CaptureChannels.StartRegionCapture]({}, {});
    shared.handlers[CaptureChannels.RegionSelected](
      { sender: shared.fakeOverlay.webContents },
      VALID_SELECTION,
    );
    await start;

    expect(shared.fakeWindow.isVisible()).toBe(true);
    expect(prepareWindowToShow).toHaveBeenCalledWith(shared.fakeWindow);
    if (process.platform === "win32") {
      expect(shared.fakeWindow.showInactive).not.toHaveBeenCalled();
    } else {
      expect(prepareWindowToShow.mock.invocationCallOrder[0]).toBeLessThan(
        shared.fakeWindow.showInactive.mock.invocationCallOrder.at(-1) ?? Infinity,
      );
    }
  });

  it.skipIf(process.platform !== "win32")(
    "parks the selection overlay without hiding it during the Windows capture workflow",
    async () => {
      vi.mocked(captureDisplay).mockImplementation(async () => {
        expect(parkSelectionWindowsForReuse).toHaveBeenCalledOnce();
        expect(hideSelectionWindows).not.toHaveBeenCalled();
        return { image: {}, scaleFactor: 1 };
      });
      vi.mocked(cropToDataUrl).mockReturnValue({
        dataUrl: "data:image/png;base64,QUJD",
        height: 10,
        ok: true,
        width: 10,
      });

      const start = shared.handlers[CaptureChannels.StartRegionCapture]({}, {});
      shared.handlers[CaptureChannels.RegionSelected](
        { sender: shared.fakeOverlay.webContents },
        VALID_SELECTION,
      );
      await start;

      expect(vi.mocked(parkSelectionWindowsForReuse).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(captureDisplay).mock.invocationCallOrder[0],
      );
      expect(vi.mocked(captureDisplay).mock.invocationCallOrder[0]).toBeLessThan(
        shared.fakeWindow.showInactive.mock.invocationCallOrder.at(-1) ?? Infinity,
      );
    },
  );

  it("returns ok:false reason cancelled when the user cancels the selection", async () => {
    const start = shared.handlers[CaptureChannels.StartRegionCapture]({}, {});
    shared.handlers[CaptureChannels.RegionCancelled]({ sender: shared.fakeOverlay.webContents });
    const result = (await start) as { ok: boolean; reason?: string };

    expect(result).toEqual({ ok: false, reason: "cancelled" });
  });

  it("maps a capture failure to its reason", async () => {
    vi.mocked(captureDisplay).mockRejectedValue(
      new ScreenCaptureError("permission", "no permission"),
    );

    const start = shared.handlers[CaptureChannels.StartRegionCapture]({}, {});
    shared.handlers[CaptureChannels.RegionSelected](
      { sender: shared.fakeOverlay.webContents },
      VALID_SELECTION,
    );
    const result = (await start) as { message?: string; ok: boolean; reason?: string };

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("permission");
    expect(result.message).toBe("no permission");
  });

  it("rejects calls from an illegal sender", async () => {
    vi.mocked(isWindowFromSender).mockReturnValue(false);

    const result = (await shared.handlers[CaptureChannels.StartRegionCapture]({}, {})) as {
      message?: string;
      ok: boolean;
      reason?: string;
    };

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("error");
    expect(result.message).toBe("非法调用方");
  });
});
