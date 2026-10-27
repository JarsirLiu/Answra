import { randomUUID } from "node:crypto";
import type { RegionCaptureOptions, RegionSelection, ScreenshotResult } from "@answra/shared";
import { CaptureChannels } from "@answra/shared";
import type { IpcMainEvent } from "electron";
import { BrowserWindow, globalShortcut, ipcMain } from "electron";
import {
  getWindow,
  hideReplyBarWindowForCapture,
  isStealthEnabled,
  isWindowFromSender,
  prepareWindowCaptureProtection,
  prepareWindowToShow,
  registerWindowSurface,
  restoreReplyBarWindowAfterCapture,
  setReplyBarAnchor,
} from "../window";
import { getWindowCaptureDiagnostics } from "../windowCaptureProtection";
import { describeForegroundWindow } from "../windowForeground";
import { captureDisplay, cropToDataUrl, ScreenCaptureError } from "./captureService";
import {
  createSelectionWindows,
  getActiveSelectionWindows,
  hideSelectionWindows,
  type SelectionWindowFocusSnapshot,
} from "./selectionWindow";

const CAPTURE_COMPOSITION_DELAY_MS = process.platform === "darwin" ? 80 : 40;

/**
 * 区域截图 IPC 编排：
 * 1. 渲染进程 invoke StartRegionCapture → 按捕获保护状态处理主窗口 → 弹出框选 overlay；
 * 2. overlay 上报选区/取消 → 停放或隐藏 overlay → 必要时恢复主窗口；
 * 3. 捕获所选显示器整屏 → 逻辑选区换算物理像素 → 裁剪编码 PNG data URL 返回。
 */
export function registerCaptureIpc(): void {
  ipcMain.handle(
    CaptureChannels.StartRegionCapture,
    async (event, options: unknown): Promise<ScreenshotResult> => {
      const fromSender = isWindowFromSender(getWindow(), event);
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
  const captureStartedAt = Date.now();
  const mainWindow = getWindow();
  const wasVisible = mainWindow?.isVisible() ?? false;
  const canKeepProtectedMainWindowVisible = Boolean(
    process.platform === "win32" &&
      isStealthEnabled() &&
      wasVisible &&
      mainWindow &&
      !mainWindow.isDestroyed() &&
      prepareWindowCaptureProtection(mainWindow),
  );
  const mainWindowHiddenForCapture = wasVisible && !canKeepProtectedMainWindowVisible;
  const replyBarWasVisible = hideReplyBarWindowForCapture();
  const focusSnapshots: SelectionWindowFocusSnapshot[] = [];
  let selectionWindows: BrowserWindow[] = [];
  let selectedDisplayId: number | undefined;
  let capturedSourceDisplayId: string | undefined;
  let outcome: "selected" | "cancelled" | "unavailable" | "error" = "error";
  try {
    if (mainWindowHiddenForCapture) mainWindow?.hide();
    selectionWindows = createSelectionWindows(line, isStealthEnabled(), {
      registerWindowSurface,
      prepareWindowToShow,
      prepareCaptureProtection: prepareWindowCaptureProtection,
      onFocusSnapshot: (snapshot) => focusSnapshots.push(snapshot),
    });
    if (selectionWindows.length === 0) {
      console.error("[capture] 无可用显示器");
      outcome = "unavailable";
      return { message: "没有可用的显示器", ok: false, reason: "unavailable" };
    }
    const selectionPromise = new Promise<RegionSelection | null>((resolve) => {
      pendingCapture = resolve;
    });
    for (const overlay of selectionWindows) {
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
    if (!selection) {
      outcome = "cancelled";
      return { ok: false, reason: "cancelled" };
    }
    selectedDisplayId = selection.displayId;
    recordCaptureFocusPhase("selection-received", selectionWindows, mainWindow, focusSnapshots);
    // The detached reply surface is positioned near the selection. Keep the
    // toolbar HWND and its bounds independent from the screenshot workflow.
    setReplyBarAnchor(selection);
    pendingCapture = undefined;
    hideSelectionWindows();
    recordCaptureFocusPhase("overlay-hidden", selectionWindows, mainWindow, focusSnapshots);
    await new Promise((resolve) => setTimeout(resolve, CAPTURE_COMPOSITION_DELAY_MS));
    recordCaptureFocusPhase("composition-settled", selectionWindows, mainWindow, focusSnapshots);
    recordCaptureFocusPhase(
      "display-capture-started",
      selectionWindows,
      mainWindow,
      focusSnapshots,
    );
    const capture = await captureDisplay(selection.displayId);
    capturedSourceDisplayId = capture.sourceDisplayId;
    recordCaptureFocusPhase(
      "display-capture-completed",
      selectionWindows,
      mainWindow,
      focusSnapshots,
    );
    const result = cropToDataUrl(capture, selection.rect);
    outcome = "selected";
    return result;
  } catch (error) {
    console.error("[capture] 区域截图失败", { captureId, error });
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
    const restoreMainWindow = () => {
      if (!mainWindowHiddenForCapture || !mainWindow || mainWindow.isDestroyed()) return false;
      if (!prepareWindowToShow(mainWindow)) return false;
      mainWindow.showInactive();
      return true;
    };
    recordCaptureFocusPhase("restore-started", selectionWindows, mainWindow, focusSnapshots);
    hideSelectionWindows();
    const mainWindowRestored = restoreMainWindow();
    recordCaptureFocusPhase("main-window-restored", selectionWindows, mainWindow, focusSnapshots);
    if (mainWindowRestored && isStealthEnabled() && process.platform === "win32") {
      // Electron applies display affinity on the next desktop composition; give DWM time
      // before the renderer receives the result and the user can start another capture.
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    restoreReplyBarWindowAfterCapture(replyBarWasVisible);
    recordCaptureFocusPhase("reply-bar-restored", selectionWindows, mainWindow, focusSnapshots);
    console.info(
      "[capture][focus]",
      JSON.stringify({
        captureId,
        startedAt: new Date(captureStartedAt).toISOString(),
        outcome,
        selectedDisplayId,
        capturedSourceDisplayId,
        timeline: focusSnapshots
          .filter((snapshot) => snapshot.event === "phase")
          .map(
            ({ phase, timestamp, visible, mainWindowVisible, mainWindowFocused, foreground }) => ({
              phase,
              elapsedMs: timestamp - captureStartedAt,
              overlayVisible: visible,
              mainWindowVisible,
              mainWindowFocused,
              foreground: foreground.className,
            }),
          ),
        overlayEvents: focusSnapshots
          .filter(
            (snapshot) =>
              snapshot.event === "show" ||
              snapshot.event === "hide" ||
              snapshot.event === "focus" ||
              snapshot.event === "blur",
          )
          .map(({ event, timestamp, foreground }) => ({
            event,
            elapsedMs: timestamp - captureStartedAt,
            foreground: foreground.className,
          })),
        mainWindow:
          mainWindow && !mainWindow.isDestroyed()
            ? {
                visible: mainWindow.isVisible(),
                focused: mainWindow.isFocused(),
                focusable: mainWindow.isFocusable(),
              }
            : { wasVisible, destroyed: mainWindow?.isDestroyed() },
        electronFocusedWindowId: BrowserWindow.getFocusedWindow()?.id,
        foreground: describeForegroundWindow(),
        captureProtection:
          mainWindow && !mainWindow.isDestroyed()
            ? getWindowCaptureDiagnostics(mainWindow)
            : undefined,
      }),
    );
  }
}

function recordCaptureFocusPhase(
  phase: NonNullable<SelectionWindowFocusSnapshot["phase"]>,
  selectionWindows: BrowserWindow[],
  mainWindow: BrowserWindow | null | undefined,
  snapshots: SelectionWindowFocusSnapshot[],
): void {
  const windows: Array<BrowserWindow | undefined> = selectionWindows.length
    ? selectionWindows
    : [undefined];
  for (const selectionWindow of windows) {
    const isSelectionWindowAvailable =
      selectionWindow !== undefined && !selectionWindow.isDestroyed();
    const isMainWindowAvailable = mainWindow != null && !mainWindow.isDestroyed();
    snapshots.push({
      event: "phase",
      phase,
      timestamp: Date.now(),
      windowId: isSelectionWindowAvailable ? selectionWindow.id : undefined,
      focusable: isSelectionWindowAvailable ? selectionWindow.isFocusable() : undefined,
      focused: isSelectionWindowAvailable ? selectionWindow.isFocused() : undefined,
      visible: isSelectionWindowAvailable ? selectionWindow.isVisible() : undefined,
      electronFocusedWindowId: BrowserWindow.getFocusedWindow()?.id,
      mainWindowVisible: isMainWindowAvailable ? mainWindow.isVisible() : undefined,
      mainWindowFocused: isMainWindowAvailable ? mainWindow.isFocused() : undefined,
      foreground: describeForegroundWindow(),
    });
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
