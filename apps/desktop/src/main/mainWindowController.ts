import path from "node:path";
import type { ContentSize } from "@answra/shared";
import { app, BrowserWindow, screen } from "electron";
import { clampContentSize } from "./windowLayout";
import type { WindowSurfaceDescriptor } from "./windowSurfaceRegistry";

const WORK_AREA_MARGIN = 24;
const INITIAL_SIZE: ContentSize = { width: 340, height: 60 };
const MAX_SIZE: ContentSize = { width: 1200, height: 900 };

export interface MainWindowControllerHost {
  registerWindowSurface: (window: BrowserWindow, descriptor: WindowSurfaceDescriptor) => void;
  prepareWindowToShow: (window: BrowserWindow) => boolean;
  onClosed: () => void;
}

/** 主导航窗口的唯一生命周期所有者；隐身策略通过 host 回调接入。 */
export function createMainWindowController(host: MainWindowControllerHost) {
  let windowRef: BrowserWindow | undefined;

  function clampToWorkArea(size: ContentSize): ContentSize {
    const display = windowRef
      ? screen.getDisplayMatching(windowRef.getBounds())
      : screen.getPrimaryDisplay();
    return clampContentSize(
      size,
      { width: display.workArea.width, height: display.workArea.height },
      WORK_AREA_MARGIN,
      MAX_SIZE,
    );
  }

  function resizeToContent(size: ContentSize): void {
    if (!windowRef || windowRef.isDestroyed()) return;
    const clamped = clampToWorkArea(size);
    const display = screen.getDisplayMatching(windowRef.getBounds());
    const area = display.workArea;
    const bounds = windowRef.getBounds();
    const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - clamped.width);
    const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - clamped.height);
    if (
      bounds.x === x &&
      bounds.y === y &&
      bounds.width === clamped.width &&
      bounds.height === clamped.height
    )
      return;
    windowRef.setBounds({ x, y, ...clamped }, false);
  }

  function create(): BrowserWindow {
    const display = screen.getPrimaryDisplay();
    const initial = clampToWorkArea(INITIAL_SIZE);
    const area = display.workArea;
    const created = new BrowserWindow({
      x: Math.round(area.x + (area.width - initial.width) / 2),
      y: area.y + 12,
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
      // Create the Windows HWND non-activating; windowSurfaceRegistry owns later reassertions.
      ...(process.platform === "win32" ? { focusable: false } : {}),
      webPreferences: {
        preload: path.join(__dirname, "../preload/index.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // 沙箱 preload 读不到 app.isPackaged，经 argv 下发打包态（preload 据此设置 interviewAvailable）。
        additionalArguments: [`--answra-packaged=${app.isPackaged}`],
      },
    });
    windowRef = created;
    host.registerWindowSurface(created, { role: "main", captureProtection: "stealth-only" });
    created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    created.webContents.on("will-navigate", (event) => event.preventDefault());
    created.once("ready-to-show", () => {
      const allowed = host.prepareWindowToShow(created);
      if (allowed) created.showInactive();
    });
    created.on("show", () => {});
    created.on("hide", () => {});
    created.on("blur", () => {});
    created.on("focus", () => {});
    created.on("minimize", () => {});
    created.on("restore", () => {});
    created.webContents.on("render-process-gone", (_event, details) =>
      console.error("[window] 渲染进程消失:", details),
    );
    created.on("unresponsive", () =>
      console.error("[window] 渲染进程无响应（疑似死锁或主线程卡死）"),
    );
    created.webContents.on("did-fail-load", (_event, code, description) =>
      console.error("[window] 页面加载失败:", code, description),
    );
    created.webContents.on("console-message", (...args: unknown[]) => {
      const details = args.find(
        (value): value is { message: string } =>
          typeof value === "object" &&
          value !== null &&
          "message" in value &&
          typeof value.message === "string",
      );
      const message = details?.message ?? (typeof args[2] === "string" ? args[2] : "");
      if (message.startsWith("[workspace][pdf]")) {
        console.info("[renderer]", message);
      } else if (/^\[settings\]\[stealth\].*(failed|rejected|unavailable)/i.test(message)) {
        console.warn("[renderer]", message);
      }
    });
    if (app.isPackaged) void created.loadFile(path.join(__dirname, "../../dist/index.html"));
    else void created.loadURL("http://127.0.0.1:5180");
    created.on("closed", () => {
      if (windowRef === created) windowRef = undefined;
      host.onClosed();
    });
    return created;
  }

  return { clampToWorkArea, create, getWindow: () => windowRef, resizeToContent };
}
