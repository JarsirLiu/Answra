import { randomUUID } from "node:crypto";
import type { RegionCaptureOptions, RegionSelection, ScreenshotResult } from "@answra/shared";
import { CaptureChannels } from "@answra/shared";
import type { IpcMainEvent } from "electron";
import { globalShortcut, ipcMain } from "electron";
import {
  getWindow,
  hideReplyBarWindowForCapture,
  isStealthEnabled,
  isWindowFromSender,
  prepareWindowToShow,
  registerWindowSurface,
  restoreReplyBarWindowAfterCapture,
  setReplyBarAnchor,
} from "../window";
import { getWindowCaptureDiagnostics } from "../windowCaptureProtection";
import { captureDisplay, cropToDataUrl, ScreenCaptureError } from "./captureService";
import {
  closeSelectionWindows,
  createSelectionWindows,
  getActiveSelectionWindows,
} from "./selectionWindow";

/**
 * 区域截图 IPC 编排：
 * 1. 渲染进程 invoke StartRegionCapture → 隐藏主窗口（避免入镜）→ 弹出框选 overlay；
 * 2. overlay 上报选区/取消 → 关闭 overlay → 恢复主窗口；
 * 3. 捕获所选显示器整屏 → 逻辑选区换算物理像素 → 裁剪编码 PNG data URL 返回。
 */
export function registerCaptureIpc(): void {
  ipcMain.handle(
    CaptureChannels.StartRegionCapture,
    async (event, options: unknown): Promise<ScreenshotResult> => {
      const fromSender = isWindowFromSender(getWindow(), event);
      console.log("[capture] StartRegionCapture 调用, 合法调用方:", fromSender);
      if (!fromSender) {
        console.error("[capture] 拒绝：非法调用方");
        return { message: "非法调用方", ok: false, reason: "error" };
      }
      if (pendingCapture) {
        console.warn("[capture] 已有截图进行中，忽略重复请求");
        return { message: "已有截图正在进行", ok: false, reason: "error" };
      }
      return runRegionCapture(sanitizeSelectionLine(options), randomUUID());
    },
  );

  ipcMain.on(CaptureChannels.RegionSelected, (event, selection: RegionSelection) => {
    if (!isValidSelection(selection)) return;
    settleFromOverlay(event, selection);
  });

  ipcMain.on(CaptureChannels.RegionCancelled, (event) => {
    settleFromOverlay(event, null);
  });
}

let pendingCapture: ((selection: RegionSelection | null) => void) | undefined;
let escapeShortcutRegistered = false;

/** 框选线色仅接受字面 CSS 颜色（hex / rgb[a]()），杜绝任意字符串注入页面。 */
const CSS_COLOR_PATTERN = /^#[0-9a-fA-F]{3,8}$|^(?:rgb|rgba)\([0-9.,%\s/]+\)$/;

/** 清洗渲染器上报的框选虚线颜色；非法或缺省返回 undefined 由 overlay 回落内置色。 */
function sanitizeSelectionLine(options: unknown): string | undefined {
  if (typeof options !== "object" || options === null) return undefined;
  const line = (options as RegionCaptureOptions).line;
  if (typeof line !== "string" || line.length === 0 || line.length > 64) return undefined;
  return CSS_COLOR_PATTERN.test(line.trim()) ? line.trim() : undefined;
}

async function runRegionCapture(
  line: string | undefined,
  captureId: string,
): Promise<ScreenshotResult> {
  const mainWindow = getWindow();
  const wasVisible = mainWindow?.isVisible() ?? false;
  const replyBarWasVisible = hideReplyBarWindowForCapture();
  console.info("[capture][diagnostic] started", {
    captureId,
    windowId: mainWindow?.id,
    wasVisible,
    stealth: isStealthEnabled(),
    bounds: mainWindow?.getBounds?.(),
  });
  try {
    mainWindow?.hide();
    console.info("[capture][diagnostic] main window hidden", {
      captureId,
      visible: mainWindow?.isVisible(),
    });
    const overlays = createSelectionWindows(line, isStealthEnabled(), {
      registerWindowSurface,
      prepareWindowToShow,
    });
    console.info("[capture][diagnostic] selection overlays created", {
      captureId,
      count: overlays.length,
      windowIds: overlays.map((window) => window.id),
      protected: isStealthEnabled(),
    });
    if (overlays.length === 0) {
      console.error("[capture] 无可用显示器");
      return { message: "没有可用的显示器", ok: false, reason: "unavailable" };
    }
    const selectionPromise = new Promise<RegionSelection | null>((resolve) => {
      pendingCapture = resolve;
    });
    for (const overlay of overlays) {
      overlay.once("closed", () => {
        if (pendingCapture && getActiveSelectionWindows().length === 0) pendingCapture(null);
      });
    }
    if (process.platform === "win32") {
      // The Windows selection overlay is intentionally non-activating, so its
      // DOM keydown handler cannot receive Escape. Scope the global shortcut
      // to the active capture session and always unregister it in finally.
      escapeShortcutRegistered = globalShortcut.register("Escape", () => {
        pendingCapture?.(null);
      });
      if (!escapeShortcutRegistered) {
        console.warn("[capture] could not register temporary Escape shortcut");
      }
    }
    const selection = await selectionPromise;
    console.info("[capture][diagnostic] selection settled", { captureId, selection });
    if (!selection) {
      console.log("[capture] 用户取消截图");
      return { ok: false, reason: "cancelled" };
    }
    // The detached reply surface is positioned near the selection. Keep the
    // toolbar HWND and its bounds independent from the screenshot workflow.
    setReplyBarAnchor(selection);
    pendingCapture = undefined;
    closeSelectionWindows();
    console.info("[capture][diagnostic] display capture started", {
      captureId,
      displayId: selection.displayId,
      windowVisible: mainWindow?.isVisible(),
    });
    const capture = await captureDisplay(selection.displayId);
    const result = cropToDataUrl(capture, selection.rect);
    console.info("[capture][diagnostic] display capture completed", {
      captureId,
      width: result.width,
      height: result.height,
    });
    return result;
  } catch (error) {
    console.error("[capture][diagnostic] failed", { captureId, error });
    if (error instanceof ScreenCaptureError) {
      return { message: error.message, ok: false, reason: error.reason };
    }
    return {
      message: error instanceof Error ? error.message : String(error),
      ok: false,
      reason: "error",
    };
  } finally {
    pendingCapture = undefined;
    if (escapeShortcutRegistered) {
      globalShortcut.unregister("Escape");
      escapeShortcutRegistered = false;
    }
    closeSelectionWindows();
    // showInactive 恢复可见但不抢焦点；之后重申捕获排除，覆盖窗口隐藏/恢复周期。
    if (wasVisible && mainWindow && !mainWindow.isDestroyed()) {
      if (prepareWindowToShow(mainWindow)) mainWindow.showInactive();
      if (isStealthEnabled() && process.platform === "win32") {
        // Electron applies display affinity on the next desktop composition; give DWM time
        // before the renderer receives the result and the user can start another capture.
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      console.info("[capture][diagnostic] main window restored", {
        captureId,
        windowId: mainWindow.id,
        visible: mainWindow.isVisible(),
        stealth: isStealthEnabled(),
        ...getWindowCaptureDiagnostics(mainWindow),
      });
    } else {
      console.info("[capture][diagnostic] main window restore skipped", {
        captureId,
        wasVisible,
        destroyed: mainWindow?.isDestroyed(),
      });
    }
    restoreReplyBarWindowAfterCapture(replyBarWasVisible);
  }
}

/** 校验事件来自框选 overlay 且仍有等待中的截图会话。 */
function settleFromOverlay(event: IpcMainEvent, selection: RegionSelection | null): void {
  if (!pendingCapture) return;
  const fromOverlay = getActiveSelectionWindows().some(
    (overlay) => overlay.webContents === event.sender,
  );
  if (!fromOverlay) return;
  pendingCapture(selection);
}

function isValidSelection(selection: unknown): selection is RegionSelection {
  if (typeof selection !== "object" || selection === null) return false;
  const candidate = selection as RegionSelection;
  return (
    Number.isFinite(candidate.displayId) &&
    isValidRect(candidate.rect) &&
    isValidPoint(candidate.point)
  );
}

function isValidPoint(point: unknown): point is { x: number; y: number } {
  if (typeof point !== "object" || point === null) return false;
  const candidate = point as { x?: unknown; y?: unknown };
  return Number.isFinite(candidate.x) && Number.isFinite(candidate.y);
}

function isValidRect(rect: unknown): boolean {
  if (typeof rect !== "object" || rect === null) return false;
  const candidate = rect as RegionSelection["rect"];
  return (
    [candidate.x, candidate.y, candidate.width, candidate.height].every((value) =>
      Number.isFinite(value),
    ) &&
    candidate.width > 0 &&
    candidate.height > 0
  );
}
