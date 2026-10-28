import path from "node:path";
import {
  type ContentSize,
  type RegionSelection,
  type ReplyBarAction,
  type ReplyBarPlacement,
  type ReplyBarState,
  WindowChannels,
} from "@answra/shared";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { app, BrowserWindow, screen } from "electron";
import {
  clampWindowBoundsToWorkArea,
  positionReplyBarSize,
  positionWindowNearPoint,
  replyBarAnchorFromBounds,
} from "./windowLayout";
import type { WindowSurfaceDescriptor } from "./windowSurfaceRegistry";

const WORK_AREA_MARGIN = 24;
const REPLY_BAR_SIZE: ContentSize = { width: 480, height: 76 };

export interface ReplyBarWindowHost {
  getMainWindow: () => BrowserWindow | undefined;
  registerWindowSurface: (window: BrowserWindow, descriptor: WindowSurfaceDescriptor) => void;
  prepareWindowToShow: (window: BrowserWindow) => boolean;
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
  let placement: ReplyBarPlacement = "above";

  function setAnchor(selection: RegionSelection): void {
    const display = screen
      .getAllDisplays()
      .find((candidate) => candidate.id === selection.displayId);
    if (!display) return;
    position = positionWindowNearPoint(
      selection.point,
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
        if (!mainWindow.isVisible()) {
          if (host.prepareWindowToShow(mainWindow)) mainWindow.showInactive();
          host.logCaptureSurfaceState("reply-bar-closed", mainWindow);
        }
      }
      position = undefined;
      return;
    }

    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isVisible()) {
      mainWindow.hide();
      host.logCaptureSurfaceState("reply-bar-opened-main-hidden", mainWindow);
    }
    if (!windowRef || windowRef.isDestroyed()) {
      createWindow(mainWindow);
      return;
    }
    windowRef.webContents.send(WindowChannels.ReplyBarState, next);
    if (!windowRef.isVisible() && host.prepareWindowToShow(windowRef)) windowRef.showInactive();
  }

  function createWindow(mainWindow: BrowserWindow): void {
    const initialPosition = position ?? {
      x: mainWindow.getBounds().x,
      y: mainWindow.getBounds().y,
    };
    position = initialPosition;
    const created = new BrowserWindow({
      ...initialPosition,
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
    host.registerWindowSurface(created, { role: "reply-bar", captureProtection: "stealth-only" });
    rendererReady = false;
    readyToShow = false;
    created.setSkipTaskbar(true);
    created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    created.webContents.on("will-navigate", (event) => event.preventDefault());
    created.on("move", () => {
      if (created.isDestroyed()) return;
      const bounds = created.getBounds();
      const workArea = screen.getDisplayMatching(bounds).workArea;
      if (!isValidWorkArea(workArea)) return;
      const clamped = clampWindowBoundsToWorkArea(bounds, workArea);
      if (bounds.x !== clamped.x || bounds.y !== clamped.y)
        created.setPosition(clamped.x, clamped.y, false);
      position = replyBarAnchorFromBounds(
        { ...bounds, x: clamped.x, y: clamped.y },
        REPLY_BAR_SIZE,
        placement,
      );
    });
    created.once("ready-to-show", () => {
      readyToShow = true;
      if (rendererReady && state && !created.isDestroyed()) {
        created.webContents.send(WindowChannels.ReplyBarState, state);
        if (host.prepareWindowToShow(created)) created.showInactive();
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
          if (host.prepareWindowToShow(owner)) owner.showInactive();
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

  function getWindow(): BrowserWindow | undefined {
    return windowRef;
  }

  function getConversationId(): string | undefined {
    return state?.conversationId;
  }

  function hideForCapture(): boolean {
    if (!windowRef || windowRef.isDestroyed() || !windowRef.isVisible()) return false;
    windowRef.hide();
    return true;
  }

  function restoreAfterCapture(wasVisible: boolean): void {
    if (wasVisible && windowRef && !windowRef.isDestroyed()) {
      if (host.prepareWindowToShow(windowRef)) windowRef.showInactive();
    }
  }

  function resize(size: ContentSize): void {
    if (!windowRef || windowRef.isDestroyed() || !isValidContentSize(size)) return;
    const area = screen.getDisplayMatching(windowRef.getBounds()).workArea;
    if (!isValidWorkArea(area)) return;
    const width = clampDimension(size.width, area.width, 1200);
    const height = clampDimension(size.height, area.height, 900);
    const bounds = windowRef.getBounds();
    const boundsAndPlacement = positionReplyBarSize(
      position ?? { x: bounds.x, y: bounds.y },
      area,
      { width, height },
      REPLY_BAR_SIZE,
    );
    const { x, y, placement: nextPlacement } = boundsAndPlacement;
    if (placement !== nextPlacement) {
      placement = nextPlacement;
      windowRef.webContents.send(WindowChannels.ReplyBarPlacement, placement);
    }
    const nextBounds = { x, y, width, height };
    if (!isValidWindowBounds(nextBounds)) return;
    if (bounds.x === x && bounds.y === y && bounds.width === width && bounds.height === height)
      return;
    try {
      windowRef.setBounds(nextBounds, false);
    } catch (error) {
      console.error("[reply-bar] failed to resize native window", error);
      return;
    }
  }

  function sendState(): void {
    if (!state || !windowRef || windowRef.isDestroyed()) return;
    rendererReady = true;
    windowRef.webContents.send(WindowChannels.ReplyBarState, state);
    if (readyToShow && !windowRef.isVisible() && host.prepareWindowToShow(windowRef))
      windowRef.showInactive();
  }

  function close(): void {
    if (windowRef && !windowRef.isDestroyed()) windowRef.close();
    windowRef = undefined;
    state = null;
    position = undefined;
    rendererReady = false;
    readyToShow = false;
    placement = "above";
  }

  return {
    close,
    getWindow,
    getConversationId,
    hideForCapture,
    isFromSender,
    resize,
    restoreAfterCapture,
    sendState,
    setAnchor,
    setState,
  };
}

function isValidContentSize(size: ContentSize): boolean {
  return (
    Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0
  );
}

function isValidWorkArea(area: Electron.Rectangle): boolean {
  return (
    Number.isFinite(area.x) &&
    Number.isFinite(area.y) &&
    Number.isFinite(area.width) &&
    Number.isFinite(area.height) &&
    area.width > 0 &&
    area.height > 0
  );
}

function clampDimension(requested: number, available: number, maximum: number): number {
  const workAreaLimit = Math.max(1, Math.floor(available));
  const marginLimit = Math.max(1, workAreaLimit - WORK_AREA_MARGIN);
  return Math.max(1, Math.min(Math.round(requested), marginLimit, maximum));
}

function isValidWindowBounds(bounds: Electron.Rectangle): boolean {
  return (
    Number.isSafeInteger(bounds.x) &&
    Number.isSafeInteger(bounds.y) &&
    Number.isSafeInteger(bounds.width) &&
    Number.isSafeInteger(bounds.height) &&
    bounds.width > 0 &&
    bounds.height > 0
  );
}
