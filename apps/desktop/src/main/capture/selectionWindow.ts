import path from "node:path";
import { app, BrowserWindow, screen } from "electron";
import type { ForegroundWindowInfo } from "../windowForeground";
import { describeForegroundWindow } from "../windowForeground";
import type { WindowSurfaceDescriptor } from "../windowSurfaceRegistry";

/**
 * 区域框选 overlay 窗口。
 *
 * 单个透明窗口覆盖所有显示器的联合边界；拖拽范围限制在起始显示器内。
 * 仅会议隐身开启时排除此窗口，普通应用内截图不能改变系统截图结果。
 */

const activeWindows = new Set<BrowserWindow>();
const WINDOWS_SELECTION_OPACITY_DELAY_MS = 60;
let pooledWindow: BrowserWindow | undefined;
let currentFocusSnapshot: SelectionWindowPolicyHost["onFocusSnapshot"] = () => {};
export interface SelectionWindowPolicyHost {
  registerWindowSurface: (window: BrowserWindow, descriptor: WindowSurfaceDescriptor) => void;
  prepareWindowToShow: (window: BrowserWindow) => boolean;
  prepareCaptureProtection: (window: BrowserWindow) => boolean;
  onFocusSnapshot: (snapshot: SelectionWindowFocusSnapshot) => void;
}

export interface SelectionWindowFocusSnapshot {
  event: "show" | "hide" | "focus" | "blur" | "overlay-closed" | "phase";
  phase?:
    | "selection-received"
    | "overlay-hidden"
    | "composition-settled"
    | "display-capture-started"
    | "display-capture-completed"
    | "restore-started"
    | "main-window-restored"
    | "reply-bar-restored";
  timestamp: number;
  windowId?: number;
  focusable?: boolean;
  focused?: boolean;
  visible?: boolean;
  electronFocusedWindowId?: number;
  mainWindowVisible?: boolean;
  mainWindowFocused?: boolean;
  foreground: ForegroundWindowInfo;
}

/** 创建覆盖虚拟桌面的框选 overlay 并显示；返回活动窗口列表。 */
export function createSelectionWindows(
  line: string | undefined,
  stealth: boolean,
  policyHost: SelectionWindowPolicyHost,
  platform: NodeJS.Platform = process.platform,
): BrowserWindow[] {
  hideSelectionWindows();
  currentFocusSnapshot = policyHost.onFocusSnapshot;
  const displays = screen.getAllDisplays();
  if (displays.length === 0) return [];
  const bounds = getCombinedDisplayBounds(displays);
  let selectionWindow = pooledWindow;
  if (!selectionWindow || selectionWindow.isDestroyed()) {
    selectionWindow = new BrowserWindow({
      ...bounds,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      alwaysOnTop: true,
      ...(platform === "darwin" ? { type: "panel" as const, enableLargerThanScreen: true } : {}),
      ...(platform === "linux" ? { type: "toolbar" as const } : {}),
      ...(platform === "win32" ? { focusable: false } : {}),
      webPreferences: {
        preload: path.join(__dirname, "../preload/selection.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    pooledWindow = selectionWindow;
    installWindowLifecycle(selectionWindow, policyHost);
  } else {
    selectionWindow.setBounds(bounds);
  }
  activeWindows.add(selectionWindow);
  const windowForLoad = selectionWindow;
  void windowForLoad
    .loadFile(path.join(__dirname, "../capture/selection.html"), {
      query: {
        originX: String(bounds.x),
        originY: String(bounds.y),
        displays: JSON.stringify(
          displays.map(({ id, bounds: displayBounds }) => ({
            id,
            ...displayBounds,
          })),
        ),
        ...(line ? { line } : {}),
        ...(stealth ? { stealth: "true" } : {}),
      },
    })
    .then(
      () => {
        if (!activeWindows.has(windowForLoad) || windowForLoad.isDestroyed()) return;
        windowForLoad.setIgnoreMouseEvents(false);
        if (platform === "win32") {
          showWindowsSelectionWindow(windowForLoad, policyHost);
          return;
        }
        if (!policyHost.prepareWindowToShow(windowForLoad)) {
          windowForLoad.close();
          return;
        }
        windowForLoad.setOpacity(1);
        windowForLoad.showInactive();
      },
      (error: unknown) => {
        console.error("[capture] 选区窗口加载失败", error);
        if (!windowForLoad.isDestroyed()) windowForLoad.close();
      },
    );
  return [...activeWindows];
}

function showWindowsSelectionWindow(
  selectionWindow: BrowserWindow,
  policyHost: SelectionWindowPolicyHost,
): void {
  // Match Natively's cropper opacity shield: establish the non-activating HWND
  // and z-order before applying capture protection, then reveal after DWM settles.
  selectionWindow.setOpacity(0);
  selectionWindow.showInactive();
  selectionWindow.moveTop();
  if (!policyHost.prepareCaptureProtection(selectionWindow)) {
    selectionWindow.close();
    return;
  }
  setTimeout(() => {
    if (selectionWindow.isDestroyed() || !activeWindows.has(selectionWindow)) return;
    selectionWindow.setOpacity(1);
  }, WINDOWS_SELECTION_OPACITY_DELAY_MS);
}

function installWindowLifecycle(
  selectionWindow: BrowserWindow,
  policyHost: SelectionWindowPolicyHost,
): void {
  const recordFocusState = (event: "show" | "hide" | "focus" | "blur") => {
    currentFocusSnapshot({
      event,
      timestamp: Date.now(),
      windowId: selectionWindow.id,
      focusable: selectionWindow.isFocusable(),
      focused: selectionWindow.isFocused(),
      electronFocusedWindowId: BrowserWindow.getFocusedWindow()?.id,
      foreground: describeForegroundWindow(),
    });
  };
  selectionWindow.on("show", () => recordFocusState("show"));
  selectionWindow.on("hide", () => recordFocusState("hide"));
  selectionWindow.on("focus", () => recordFocusState("focus"));
  selectionWindow.on("blur", () => recordFocusState("blur"));
  policyHost.registerWindowSurface(selectionWindow, {
    role: "selection-overlay",
    captureProtection: "stealth-only",
    failClosed: true,
  });
  selectionWindow.once("closed", () => {
    currentFocusSnapshot({
      event: "overlay-closed",
      timestamp: Date.now(),
      windowId: selectionWindow.id,
      electronFocusedWindowId: BrowserWindow.getFocusedWindow()?.id,
      foreground: describeForegroundWindow(),
    });
    activeWindows.delete(selectionWindow);
    if (pooledWindow === selectionWindow) pooledWindow = undefined;
  });
}

function getCombinedDisplayBounds(displays: Electron.Display[]): Electron.Rectangle {
  const left = Math.min(...displays.map(({ bounds }) => bounds.x));
  const top = Math.min(...displays.map(({ bounds }) => bounds.y));
  const right = Math.max(...displays.map(({ bounds }) => bounds.x + bounds.width));
  const bottom = Math.max(...displays.map(({ bounds }) => bounds.y + bounds.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** 将选区窗透明化并隐藏，保留原生窗口供后续截图复用。 */
export function hideSelectionWindows(): void {
  for (const selectionWindow of activeWindows) {
    if (selectionWindow.isDestroyed()) continue;
    if (process.platform === "win32") selectionWindow.setOpacity(0);
    selectionWindow.hide();
  }
  activeWindows.clear();
}

/** 应用退出时销毁复用窗口；常规截图结束时必须隐藏而非关闭。 */
export function disposeSelectionWindow(): void {
  hideSelectionWindows();
  if (pooledWindow && !pooledWindow.isDestroyed()) pooledWindow.close();
  pooledWindow = undefined;
}

app.on("before-quit", disposeSelectionWindow);

/** 当前存活的框选 overlay（用于校验上报事件确实来自 overlay）。 */
export function getActiveSelectionWindows(): BrowserWindow[] {
  return [...activeWindows].filter((selectionWindow) => !selectionWindow.isDestroyed());
}
