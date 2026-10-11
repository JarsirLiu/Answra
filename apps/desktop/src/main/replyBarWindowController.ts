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
import { setWindowCaptureProtection } from "./windowCaptureProtection";
import { positionWindowNearSelection } from "./windowLayout";

const WORK_AREA_MARGIN = 24;
const REPLY_BAR_SIZE: ContentSize = { width: 480, height: 76 };

export interface ReplyBarWindowHost {
  getMainWindow: () => BrowserWindow | undefined;
  isStealthEnabled: () => boolean;
  logCaptureSurfaceState: (reason: string, window: BrowserWindow) => void;
  sendReplyBarAction: (action: ReplyBarAction) => void;
}

/** Owns the detached reply surface and keeps its HWND lifecycle out of window.ts. */
export function createReplyBarWindowController(host: ReplyBarWindowHost) {
  let windowRef: BrowserWindow | undefined;
  let position: { x: number; y: number } | undefined;
  let state: ReplyBarState | null = null;
  let rendererReady = false;
  let readyToShow = false;

  function setAnchor(selection: RegionSelection): void {
    const display = screen
      .getAllDisplays()
      .find((candidate) => candidate.id === selection.displayId);
    if (!display) return;
    position = positionWindowNearSelection(
      selection.rect,
      display.bounds,
      display.workArea,
      REPLY_BAR_SIZE,
    );
  }

  function setState(next: ReplyBarState | null): void {
    const mainWindow = host.getMainWindow();
    state = next;
    if (!next) {
      if (windowRef && !windowRef.isDestroyed()) windowRef.close();
      windowRef = undefined;
      state = null;
      rendererReady = false;
      readyToShow = false;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.showInactive();
        host.logCaptureSurfaceState("reply-bar-closed", mainWindow);
      }
      position = undefined;
      return;
    }

    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.hide();
    host.logCaptureSurfaceState("reply-bar-opened-main-hidden", mainWindow);
    if (!windowRef || windowRef.isDestroyed()) {
      createWindow(mainWindow);
      return;
    }
    windowRef.webContents.send(WindowChannels.ReplyBarState, next);
    if (!windowRef.isVisible()) windowRef.showInactive();
  }

  function createWindow(mainWindow: BrowserWindow): void {
    const created = new BrowserWindow({
      ...(position ?? { x: mainWindow.getBounds().x, y: mainWindow.getBounds().y }),
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
    windowRef = created;
    rendererReady = false;
    readyToShow = false;
    created.setAlwaysOnTop(true, "floating");
    created.setSkipTaskbar(true);
    created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    created.webContents.on("will-navigate", (event) => event.preventDefault());
    setWindowCaptureProtection(created, host.isStealthEnabled());
    created.on("show", () => setWindowCaptureProtection(created, host.isStealthEnabled()));
    created.on("resize", () => setWindowCaptureProtection(created, host.isStealthEnabled()));
    created.once("ready-to-show", () => {
      readyToShow = true;
      if (rendererReady && state && !created.isDestroyed()) {
        created.webContents.send(WindowChannels.ReplyBarState, state);
        created.showInactive();
      }
    });
    created.on("closed", () => {
      if (windowRef === created) {
        windowRef = undefined;
        readyToShow = false;
        rendererReady = false;
      }
      if (state) {
        state = null;
        const owner = host.getMainWindow();
        if (owner && !owner.isDestroyed()) {
          owner.showInactive();
          host.logCaptureSurfaceState("reply-bar-native-close", owner);
        }
        host.sendReplyBarAction({ type: "close" });
      }
    });
    if (app.isPackaged) {
      void created.loadFile(path.join(__dirname, "../../dist/index.html"), {
        query: { surface: "reply" },
      });
    } else {
      void created.loadURL("http://127.0.0.1:5180/?surface=reply");
    }
  }

  function isFromSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    return event.sender === windowRef?.webContents;
  }

  function hideForCapture(): boolean {
    if (!windowRef || windowRef.isDestroyed() || !windowRef.isVisible()) return false;
    windowRef.hide();
    return true;
  }

  function restoreAfterCapture(wasVisible: boolean): void {
    if (wasVisible && windowRef && !windowRef.isDestroyed()) {
      windowRef.showInactive();
      setWindowCaptureProtection(windowRef, host.isStealthEnabled());
    }
  }

  function resize(size: ContentSize): void {
    if (!windowRef || windowRef.isDestroyed() || !isValidContentSize(size)) return;
    const area = screen.getDisplayMatching(windowRef.getBounds()).workArea;
    const width = Math.min(size.width, area.width - WORK_AREA_MARGIN, 1200);
    const height = Math.min(size.height, area.height - WORK_AREA_MARGIN, 900);
    const bounds = windowRef.getBounds();
    const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - width);
    const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - height);
    if (bounds.x === x && bounds.y === y && bounds.width === width && bounds.height === height)
      return;
    windowRef.setBounds({ x, y, width, height }, false);
    setWindowCaptureProtection(windowRef, host.isStealthEnabled());
  }

  function sendState(): void {
    if (!state || !windowRef || windowRef.isDestroyed()) return;
    rendererReady = true;
    windowRef.webContents.send(WindowChannels.ReplyBarState, state);
    if (readyToShow && !windowRef.isVisible()) windowRef.showInactive();
  }

  function setCaptureProtection(enabled: boolean): void {
    if (windowRef && !windowRef.isDestroyed()) setWindowCaptureProtection(windowRef, enabled);
  }

  function close(): void {
    if (windowRef && !windowRef.isDestroyed()) windowRef.close();
    windowRef = undefined;
    state = null;
    position = undefined;
    rendererReady = false;
    readyToShow = false;
  }

  return {
    close,
    hideForCapture,
    isFromSender,
    resize,
    restoreAfterCapture,
    sendState,
    setAnchor,
    setCaptureProtection,
    setState,
  };
}

function isValidContentSize(size: ContentSize): boolean {
  return (
    Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0
  );
}
