import os from "node:os";
import path from "node:path";
import type { ContentSize } from "@answra/shared";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { app, BrowserWindow, screen } from "electron";

const WORK_AREA_MARGIN = 24;
/** 初始胶囊尺寸的兜底值；真实尺寸由渲染进程 fitContent 上报。 */
const INITIAL_SIZE: ContentSize = { width: 340, height: 60 };
/** 内容尺寸的绝对上限，防止渲染器异常上报撑爆屏幕。 */
const MAX_SIZE: ContentSize = { width: 1200, height: 900 };

let windowRef: BrowserWindow | undefined;

/** 把内容尺寸 clamp 到当前显示器工作区。 */
function clampToWorkArea(size: ContentSize): ContentSize {
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
  windowRef.setBounds({ x, y, ...clamped }, true);
}

export function getWindow(): BrowserWindow | undefined {
  return windowRef;
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
  if (!window || window.isDestroyed()) return;
  window.setContentProtection(value);
  window.setSkipTaskbar(value);
  if (process.platform === "darwin") {
    if (value) app.dock?.hide();
    else app.dock?.show();
  }
}

/** WDA_EXCLUDEFROMCAPTURE 从 Windows 10 2004（build 19041）开始可用。 */
const MIN_WINDOWS_BUILD = 19041;

/**
 * 当前系统是否可靠支持会议隐身（内容保护）。
 * 旧 Windows 会退化为捕获黑块（更扎眼），Linux 无等价能力，均视为不支持。
 */
export function isStealthSupported(): boolean {
  if (process.platform === "win32") {
    const build = Number(os.release().split(".")[2]);
    return Number.isFinite(build) && build >= MIN_WINDOWS_BUILD;
  }
  return process.platform === "darwin";
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
  createdWindow.once("ready-to-show", () => createdWindow.show());

  if (app.isPackaged) {
    void createdWindow.loadFile(path.join(__dirname, "../../dist/index.html"));
  } else {
    void createdWindow.loadURL("http://127.0.0.1:5180");
  }

  createdWindow.on("closed", () => {
    windowRef = undefined;
  });
  return createdWindow;
}

export { app };
