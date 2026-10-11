import path from "node:path";
import {
  type ContentSize,
  type RegionSelection,
  type ReplyBarAction,
  type ReplyBarState,
  WindowChannels,
} from "@answra/shared";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { app, BrowserWindow, screen } from "electron";
import { createReplyBarWindowController } from "./replyBarWindowController";
import {
  getWindowCaptureDiagnostics,
  isWindowCaptureProtectionSupported,
  setWindowCaptureProtection,
} from "./windowCaptureProtection";
import { clampContentSize } from "./windowLayout";

const WORK_AREA_MARGIN = 24;
/** 初始胶囊尺寸的兜底值；真实尺寸由渲染进程 fitContent 上报。 */
const INITIAL_SIZE: ContentSize = { width: 340, height: 60 };
/** 内容尺寸的绝对上限，防止渲染器异常上报撑爆屏幕。 */
const MAX_SIZE: ContentSize = { width: 1200, height: 900 };

let windowRef: BrowserWindow | undefined;
let stealthEnabled = false;
const replyBarController = createReplyBarWindowController({
  getMainWindow: () => windowRef,
  isStealthEnabled: () => stealthEnabled,
  logCaptureSurfaceState,
  sendReplyBarAction: (action) => {
    const mainWindow = windowRef;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(WindowChannels.ReplyBarAction, action);
    }
  },
});

/** 把内容尺寸 clamp 到当前显示器工作区。导出供测试。 */
export function clampToWorkArea(size: ContentSize): ContentSize {
  const display = windowRef
    ? screen.getDisplayMatching(windowRef.getBounds())
    : screen.getPrimaryDisplay();
  const { width: areaWidth, height: areaHeight } = display.workArea;
  return clampContentSize(
    size,
    { width: areaWidth, height: areaHeight },
    WORK_AREA_MARGIN,
    MAX_SIZE,
  );
}

/**
 * 按渲染器上报的内容尺寸调整窗口，保持左上角锚点不动，
 * 并把窗口整体推回工作区内。窗口尺寸永远紧贴外壳内容，
 * 胶囊态窗口即胶囊大小，面板打开时向下/向右扩展。
 */
export function resizeWindowToContent(size: ContentSize): void {
  if (!windowRef || windowRef.isDestroyed()) return;
  const clamped = clampToWorkArea(size);
  const display = screen.getDisplayMatching(windowRef.getBounds());
  const { x: areaX, y: areaY, width: areaWidth, height: areaHeight } = display.workArea;
  const bounds = windowRef.getBounds();
  const x = Math.min(Math.max(bounds.x, areaX), areaX + areaWidth - clamped.width);
  const y = Math.min(Math.max(bounds.y, areaY), areaY + areaHeight - clamped.height);
  if (
    bounds.x === x &&
    bounds.y === y &&
    bounds.width === clamped.width &&
    bounds.height === clamped.height
  ) {
    return;
  }
  windowRef.setBounds({ x, y, ...clamped }, false);
  refreshStealthCaptureProtection("content-resize");
  if (stealthEnabled) {
    console.info("[window][capture-diagnostic] after content resize", {
      requestedSize: clamped,
      ...getWindowCaptureDiagnostics(windowRef),
    });
  }
}

export function getWindow(): BrowserWindow | undefined {
  return windowRef;
}

export function isStealthEnabled(): boolean {
  return stealthEnabled;
}

export { positionWindowNearSelection } from "./windowLayout";

export function setReplyBarAnchor(selection: RegionSelection): void {
  replyBarController.setAnchor(selection);
}

export function setReplyBarWindowState(state: ReplyBarState | null): void {
  replyBarController.setState(state);
}

export function isReplyBarWindowFromSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return replyBarController.isFromSender(event);
}

export function hideReplyBarWindowForCapture(): boolean {
  return replyBarController.hideForCapture();
}

export function restoreReplyBarWindowAfterCapture(wasVisible: boolean): void {
  replyBarController.restoreAfterCapture(wasVisible);
}

export function resizeReplyBarWindow(size: ContentSize): void {
  replyBarController.resize(size);
}

export function sendReplyBarAction(action: ReplyBarAction): void {
  const mainWindow = getWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(WindowChannels.ReplyBarAction, action);
  }
}

export function sendReplyBarState(): void {
  replyBarController.sendState();
}

/** 校验 IPC 事件确实来自主窗口的 webContents，防止其他 sender 调用。 */
export function isWindowFromSender(
  window: BrowserWindow | undefined,
  event: IpcMainEvent | IpcMainInvokeEvent,
): boolean {
  return event.sender === window?.webContents;
}

/**
 * 应用会议隐身：内容保护 + 从任务栏/Dock 与 Alt+Tab/Cmd+Tab 隐藏。
 * - 内容保护：屏幕共享/截图捕获到空白（Windows 10 2004+ 可靠；macOS 不保证挡系统级共享）；
 * - Windows/Linux：setSkipTaskbar 同时从任务栏与 Alt+Tab 移除（WS_EX_TOOLWINDOW）；
 * - macOS：转为 accessory 激活策略，从 Dock 与 Cmd+Tab 移除。
 */
export function applyStealth(value: boolean): void {
  const window = getWindow();
  if (!window || window.isDestroyed()) {
    console.warn("[settings][stealth] cannot apply state: main window unavailable");
    return;
  }
  console.info("[settings][stealth] applying state", value);
  stealthEnabled = value;
  const contentProtectionApplied = setWindowCaptureProtection(window, value);
  console.info("[settings][stealth] application result", {
    enabled: value,
    contentProtectionApplied,
    windowId: window.id,
  });
  replyBarController.setCaptureProtection(value);
  window.setSkipTaskbar(value);
  if (process.platform === "darwin") {
    if (value) app.dock?.hide();
    else app.dock?.show();
  }
}

/**
 * 截图流程会隐藏再显示主窗口。恢复后重申捕获排除标志，确保窗口可见性切换
 * 不会让会议隐身依赖旧 HWND 状态；此操作只管理捕获保护，不触碰其他隐身策略。
 */
export function refreshStealthCaptureProtection(_reason = "window-restore"): void {
  const window = getWindow();
  if (!stealthEnabled || !window || window.isDestroyed()) return;
  // Protection refreshes are intentionally quiet; the protection adapter logs
  // only an actual state change, mismatch, or failure to avoid resize log spam.
  setWindowCaptureProtection(window, true);
}

function logCaptureSurfaceState(reason: string, window: BrowserWindow): void {
  console.info("[window][capture-protection] surface lifecycle", {
    reason,
    ...getWindowCaptureDiagnostics(window),
  });
}

/**
 * 当前系统是否支持窗口捕获排除。旧 Windows 的 Electron 实现退化为黑块，
 * Linux 没有等价能力；任务栏/Dock 隐藏不受此检测结果影响。
 */
export function isStealthSupported(): boolean {
  return isWindowCaptureProtectionSupported();
}

export function createMainWindow(): BrowserWindow {
  const display = screen.getPrimaryDisplay();
  const initial = clampToWorkArea(INITIAL_SIZE);
  const { x: areaX, y: areaY, width: areaWidth } = display.workArea;
  const createdWindow = new BrowserWindow({
    x: Math.round(areaX + (areaWidth - initial.width) / 2),
    y: areaY + 12,
    width: initial.width,
    height: initial.height,
    minWidth: 200,
    minHeight: 40,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    hasShadow: false,
    roundedCorners: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  windowRef = createdWindow;

  createdWindow.setAlwaysOnTop(true, "floating");
  createdWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  createdWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  // Windows may lose capture exclusion across Electron hide/show cycles. Reapply
  // on the native show event as well as in the screenshot workflow's restore path.
  createdWindow.on("show", () => refreshStealthCaptureProtection("native-show"));
  // Content panels resize this window; keep its capture policy across native resizes.
  createdWindow.on("resize", () => refreshStealthCaptureProtection("native-resize"));
  createdWindow.once("ready-to-show", () => createdWindow.show());

  // 渲染进程异常兜底：透明窗口上播放 WGC 桌面流可能拖垮 GPU 进程，
  // 不加监听则“整块卡死”无任何日志。这里集中打印，便于定位冻结根因。
  createdWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error("[window] 渲染进程消失:", details);
  });
  createdWindow.on("unresponsive", () => {
    console.error("[window] 渲染进程无响应（疑似死锁/主线程卡死）");
  });
  createdWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    console.error("[window] 页面加载失败:", errorCode, errorDescription);
  });
  createdWindow.webContents.on("console-message", (...args: unknown[]) => {
    const event = args[0] as { message?: unknown } | undefined;
    const message =
      typeof event?.message === "string"
        ? event.message
        : typeof args[2] === "string"
          ? args[2]
          : "";
    // Renderer diagnostics are intentionally quiet. Native capture diagnostics
    // remain in the main process so routine theme updates cannot hide them.
    if (/^\[settings\]\[stealth\].*(failed|rejected|unavailable)/i.test(message)) {
      console.warn("[renderer]", message);
    }
  });

  if (app.isPackaged) {
    void createdWindow.loadFile(path.join(__dirname, "../../dist/index.html"));
  } else {
    void createdWindow.loadURL("http://127.0.0.1:5180");
  }

  createdWindow.on("closed", () => {
    replyBarController.close();
    windowRef = undefined;
  });
  return createdWindow;
}

export { app };
