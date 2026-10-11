import path from "node:path";
import {
  type ContentSize,
  type RegionRect,
  type RegionSelection,
  type ReplyBarAction,
  type ReplyBarState,
  WindowChannels,
} from "@answra/shared";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { app, BrowserWindow, screen } from "electron";
import {
  getWindowCaptureDiagnostics,
  isWindowCaptureProtectionSupported,
  setWindowCaptureProtection,
} from "./windowCaptureProtection";

const WORK_AREA_MARGIN = 24;
/** 窗口与选区之间的呼吸间距，与 WORK_AREA_MARGIN 同尺度。 */
const SELECTION_GAP = 12;
/** 初始胶囊尺寸的兜底值；真实尺寸由渲染进程 fitContent 上报。 */
const INITIAL_SIZE: ContentSize = { width: 340, height: 60 };
/** 内容尺寸的绝对上限，防止渲染器异常上报撑爆屏幕。 */
const MAX_SIZE: ContentSize = { width: 1200, height: 900 };

let windowRef: BrowserWindow | undefined;
let replyBarWindow: BrowserWindow | undefined;
let replyBarPosition: { x: number; y: number } | undefined;
let replyBarState: ReplyBarState | null = null;
let replyBarRendererReady = false;
let replyBarWindowReadyToShow = false;
let stealthEnabled = false;
const REPLY_BAR_SIZE: ContentSize = { width: 480, height: 76 };

/** 把内容尺寸 clamp 到当前显示器工作区。导出供测试。 */
export function clampToWorkArea(size: ContentSize): ContentSize {
  const display = windowRef
    ? screen.getDisplayMatching(windowRef.getBounds())
    : screen.getPrimaryDisplay();
  const { width: areaWidth, height: areaHeight } = display.workArea;
  return {
    width: Math.min(size.width, MAX_SIZE.width, areaWidth - WORK_AREA_MARGIN),
    height: Math.min(size.height, MAX_SIZE.height, areaHeight - WORK_AREA_MARGIN),
  };
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

/**
 * 计算窗口贴近选区的落位：优先放选区正下方（水平对齐选区中心），
 * 越过工作区边界时整体推回。选区坐标是“相对所选显示器左上角”的逻辑像素，
 * 与显示器 bounds 相加得到屏幕坐标。导出供测试。
 */
export function positionWindowNearSelection(
  rect: RegionRect,
  displayBounds: { x: number; y: number },
  workArea: { x: number; y: number; width: number; height: number },
  windowSize: { width: number; height: number },
): { x: number; y: number } {
  const x = Math.round(rect.x + displayBounds.x + (rect.width - windowSize.width) / 2);
  const y = Math.round(rect.y + displayBounds.y + rect.height + SELECTION_GAP);
  return {
    x: Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - windowSize.width),
    y: Math.min(Math.max(y, workArea.y), workArea.y + workArea.height - windowSize.height),
  };
}

/** Place the detached workflow window beside the selected screen region. */
export function setReplyBarAnchor(selection: RegionSelection): void {
  const display = screen.getAllDisplays().find((candidate) => candidate.id === selection.displayId);
  if (!display) return;
  replyBarPosition = positionWindowNearSelection(
    selection.rect,
    display.bounds,
    display.workArea,
    REPLY_BAR_SIZE,
  );
}

/**
 * The reply workflow owns a separate HWND so its show/resize lifecycle cannot
 * change the toolbar window's capture surface or bounds.
 */
export function setReplyBarWindowState(state: ReplyBarState | null): void {
  const mainWindow = getWindow();
  replyBarState = state;
  if (!state) {
    if (replyBarWindow && !replyBarWindow.isDestroyed()) replyBarWindow.close();
    replyBarWindow = undefined;
    replyBarState = null;
    replyBarRendererReady = false;
    replyBarWindowReadyToShow = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.showInactive();
      logCaptureSurfaceState("reply-bar-closed", mainWindow);
    }
    replyBarPosition = undefined;
    return;
  }

  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();
  logCaptureSurfaceState("reply-bar-opened-main-hidden", mainWindow);
  if (!replyBarWindow || replyBarWindow.isDestroyed()) {
    const pos = replyBarPosition ?? {
      x: mainWindow.getBounds().x,
      y: mainWindow.getBounds().y,
    };
    const created = new BrowserWindow({
      ...pos,
      ...REPLY_BAR_SIZE,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "../preload/index.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    replyBarWindow = created;
    replyBarRendererReady = false;
    replyBarWindowReadyToShow = false;
    created.setAlwaysOnTop(true, "floating");
    created.setSkipTaskbar(true);
    created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    created.webContents.on("will-navigate", (event) => event.preventDefault());
    setWindowCaptureProtection(created, stealthEnabled);
    created.on("show", () => setWindowCaptureProtection(created, stealthEnabled));
    created.on("resize", () => setWindowCaptureProtection(created, stealthEnabled));
    created.once("ready-to-show", () => {
      replyBarWindowReadyToShow = true;
      if (replyBarRendererReady && replyBarState && !created.isDestroyed()) {
        created.webContents.send(WindowChannels.ReplyBarState, replyBarState);
        created.showInactive();
      }
    });
    created.on("closed", () => {
      if (replyBarWindow === created) {
        replyBarWindow = undefined;
        replyBarWindowReadyToShow = false;
        replyBarRendererReady = false;
      }
      if (replyBarState) {
        replyBarState = null;
        const owner = getWindow();
        if (owner && !owner.isDestroyed()) {
          owner.showInactive();
          logCaptureSurfaceState("reply-bar-native-close", owner);
        }
        sendReplyBarAction({ type: "close" });
      }
    });
    if (app.isPackaged) {
      void created.loadFile(path.join(__dirname, "../../dist/index.html"), {
        query: { surface: "reply" },
      });
    } else {
      void created.loadURL("http://127.0.0.1:5180/?surface=reply");
    }
    return;
  }
  replyBarWindow.webContents.send(WindowChannels.ReplyBarState, state);
  if (!replyBarWindow.isVisible()) replyBarWindow.showInactive();
}

export function isReplyBarWindowFromSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return event.sender === replyBarWindow?.webContents;
}

export function hideReplyBarWindowForCapture(): boolean {
  const window = replyBarWindow;
  if (!window || window.isDestroyed() || !window.isVisible()) return false;
  window.hide();
  return true;
}

export function restoreReplyBarWindowAfterCapture(wasVisible: boolean): void {
  const window = replyBarWindow;
  if (wasVisible && window && !window.isDestroyed()) {
    window.showInactive();
    setWindowCaptureProtection(window, stealthEnabled);
  }
}

export function resizeReplyBarWindow(size: ContentSize): void {
  const window = replyBarWindow;
  if (!window || window.isDestroyed() || !isValidContentSize(size)) return;
  const display = screen.getDisplayMatching(window.getBounds());
  const area = display.workArea;
  const width = Math.min(size.width, area.width - WORK_AREA_MARGIN, MAX_SIZE.width);
  const height = Math.min(size.height, area.height - WORK_AREA_MARGIN, MAX_SIZE.height);
  const bounds = window.getBounds();
  const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - height);
  if (bounds.x === x && bounds.y === y && bounds.width === width && bounds.height === height) {
    return;
  }
  window.setBounds({ x, y, width, height }, false);
  setWindowCaptureProtection(window, stealthEnabled);
}

export function sendReplyBarAction(action: ReplyBarAction): void {
  const mainWindow = getWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(WindowChannels.ReplyBarAction, action);
  }
}

export function sendReplyBarState(): void {
  const window = replyBarWindow;
  if (!replyBarState || !window || window.isDestroyed()) return;
  replyBarRendererReady = true;
  window.webContents.send(WindowChannels.ReplyBarState, replyBarState);
  if (replyBarWindowReadyToShow && !window.isVisible()) window.showInactive();
}

function isValidContentSize(size: ContentSize): boolean {
  return (
    Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0
  );
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
  if (replyBarWindow && !replyBarWindow.isDestroyed()) {
    setWindowCaptureProtection(replyBarWindow, value);
  }
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
    replyBarState = null;
    if (replyBarWindow && !replyBarWindow.isDestroyed()) replyBarWindow.close();
    replyBarWindow = undefined;
    windowRef = undefined;
  });
  return createdWindow;
}

export { app };
