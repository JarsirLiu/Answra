import path from "node:path";
import type { OverlayMode } from "@exam-assistant/shared";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { app, BrowserWindow, screen } from "electron";

/** 各面板打开时的窗口高度；closed = 仅悬浮条。 */
const WINDOW_HEIGHTS: Record<OverlayMode, number> = {
  closed: 52,
  chat: 760,
  notes: 620,
  sources: 620,
  settings: 560,
};

const WINDOW_WIDTH = 780;
const WORK_AREA_MARGIN = 24;

let windowRef: BrowserWindow | undefined;

function computeBounds(mode: OverlayMode): { x: number; y: number; width: number; height: number } {
  const display = windowRef
    ? screen.getDisplayMatching(windowRef.getBounds())
    : screen.getPrimaryDisplay();
  const { x: areaX, y: areaY, width: areaWidth, height: areaHeight } = display.workArea;
  const width = Math.min(WINDOW_WIDTH, areaWidth - WORK_AREA_MARGIN);
  const height = Math.min(WINDOW_HEIGHTS[mode], areaHeight - WORK_AREA_MARGIN);
  return {
    width,
    height,
    x: Math.round(areaX + (areaWidth - width) / 2),
    y: areaY + 12,
  };
}

/** 按面板模式调整窗口大小，保持居中并限制在当前显示器工作区内。 */
export function resizeWindowForMode(mode: OverlayMode): void {
  if (!windowRef || windowRef.isDestroyed()) return;
  windowRef.setBounds(computeBounds(mode), true);
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

export function createMainWindow(): BrowserWindow {
  const createdWindow = new BrowserWindow({
    ...computeBounds("closed"),
    minWidth: 680,
    minHeight: WINDOW_HEIGHTS.closed,
    maxHeight: 900,
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
