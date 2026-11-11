import path from "node:path";
import {
  type ContentSize,
  SurfaceChannels,
  type SurfaceSpec,
  type SurfaceWindowState,
} from "@answra/shared";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { app, BrowserWindow, screen } from "electron";
import { clampWindowBoundsToWorkArea } from "../windowLayout";
import type { WindowSurfaceDescriptor } from "../windowSurfaceRegistry";
import type { SurfacePosition } from "./surfaceStateStore";

const DEFAULT_SURFACE_WIDTH = 320;
const DEFAULT_SURFACE_HEIGHT = 180;
const MIN_SURFACE_WIDTH = 220;
const MAX_SURFACE_WIDTH = 560;
const MIN_SURFACE_HEIGHT = 80;
const MAX_SURFACE_HEIGHT = 900;
const WORK_AREA_MARGIN = 24;
const POSITION_PERSIST_DELAY_MS = 200;

export interface SurfaceWindowControllerHost {
  registerWindowSurface: (window: BrowserWindow, descriptor: WindowSurfaceDescriptor) => void;
  prepareWindowToShow: (window: BrowserWindow) => boolean;
  isStealthEnabled: () => boolean;
  readPosition: () => SurfacePosition | undefined;
  writePosition: (position: SurfacePosition) => void;
}

/** Owns the single declarative surface window used by product presets. */
export function createSurfaceWindowController(host: SurfaceWindowControllerHost) {
  let windowRef: BrowserWindow | undefined;
  let spec: SurfaceSpec | undefined;
  let rendererReady = false;
  let readyToShow = false;
  let position: SurfacePosition | undefined;
  let positionPersistTimer: ReturnType<typeof setTimeout> | undefined;
  let dismissTimer: ReturnType<typeof setTimeout> | undefined;

  function getState(): SurfaceWindowState | undefined {
    return spec ? { spec, stealth: host.isStealthEnabled() } : undefined;
  }

  function show(nextSpec: SurfaceSpec): void {
    spec = nextSpec;
    clearTtl();
    scheduleTtl(nextSpec);
    if (!windowRef || windowRef.isDestroyed()) {
      createWindow();
      return;
    }
    if (rendererReady) sendState();
    if (!windowRef.isVisible() && host.prepareWindowToShow(windowRef)) windowRef.showInactive();
  }

  function sendState(): void {
    const state = getState();
    if (!state || !windowRef || windowRef.isDestroyed()) return;
    windowRef.webContents.send(SurfaceChannels.State, state);
  }

  function handleReady(): void {
    rendererReady = true;
    if (readyToShow) showWhenReady();
  }

  function showWhenReady(): void {
    if (!windowRef || windowRef.isDestroyed()) return;
    sendState();
    if (host.prepareWindowToShow(windowRef)) windowRef.showInactive();
  }

  function dismiss(): void {
    clearTtl();
    flushPositionPersist();
    spec = undefined;
    if (windowRef && !windowRef.isDestroyed() && windowRef.isVisible()) windowRef.hide();
  }

  function resize(size: ContentSize): void {
    if (!windowRef || windowRef.isDestroyed() || !isValidSize(size)) return;
    const bounds = windowRef.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    const width = clampDimension(size.width, area.width, MIN_SURFACE_WIDTH, MAX_SURFACE_WIDTH);
    const height = clampDimension(size.height, area.height, MIN_SURFACE_HEIGHT, MAX_SURFACE_HEIGHT);
    const next = clampWindowBoundsToWorkArea({ ...bounds, width, height }, area);
    if (
      bounds.x === next.x &&
      bounds.y === next.y &&
      bounds.width === next.width &&
      bounds.height === next.height
    ) {
      return;
    }
    try {
      windowRef.setBounds(next, false);
    } catch (error) {
      console.error("[surface] failed to resize native window", error);
      return;
    }
    position = { x: next.x, y: next.y };
    schedulePositionPersist();
  }

  function isFromSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    return event.sender === windowRef?.webContents;
  }

  function createWindow(): void {
    const width = clampWidth(spec?.window?.width ?? DEFAULT_SURFACE_WIDTH);
    const initial = resolveInitialPosition(width);
    position = initial;
    const created = new BrowserWindow({
      ...initial,
      width,
      height: DEFAULT_SURFACE_HEIGHT,
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
      // Create the Windows HWND non-activating; the registry reasserts the policy.
      ...(process.platform === "win32" ? { focusable: false } : {}),
      webPreferences: {
        preload: path.join(__dirname, "../preload/index.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    windowRef = created;
    host.registerWindowSurface(created, {
      role: "surface",
      captureProtection: "stealth-only",
      failClosed: true,
    });
    rendererReady = false;
    readyToShow = false;
    created.setSkipTaskbar(true);
    created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    created.webContents.on("will-navigate", (event) => event.preventDefault());
    created.on("move", () => {
      if (created.isDestroyed()) return;
      const bounds = created.getBounds();
      const area = screen.getDisplayMatching(bounds).workArea;
      const clamped = clampWindowBoundsToWorkArea(bounds, area);
      if (bounds.x !== clamped.x || bounds.y !== clamped.y) {
        created.setPosition(clamped.x, clamped.y, false);
      }
      position = { x: clamped.x, y: clamped.y };
      schedulePositionPersist();
    });
    created.once("ready-to-show", () => {
      readyToShow = true;
      if (rendererReady) showWhenReady();
    });
    created.on("closed", () => {
      if (windowRef === created) {
        windowRef = undefined;
        spec = undefined;
        rendererReady = false;
        readyToShow = false;
        clearTtl();
        flushPositionPersist();
      }
    });
    if (app.isPackaged) {
      void created.loadFile(path.join(__dirname, "../../dist/index.html"), {
        query: { surface: "surface" },
      });
    } else {
      void created.loadURL("http://127.0.0.1:5180/?surface=surface");
    }
  }

  function resolveInitialPosition(width: number): SurfacePosition {
    const area = screen.getPrimaryDisplay().workArea;
    const saved = host.readPosition();
    const base = saved ?? {
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + (area.height - DEFAULT_SURFACE_HEIGHT) / 2),
    };
    const clamped = clampWindowBoundsToWorkArea(
      { x: base.x, y: base.y, width, height: DEFAULT_SURFACE_HEIGHT },
      area,
    );
    return { x: clamped.x, y: clamped.y };
  }

  function clampWidth(requested: number): number {
    const area = screen.getPrimaryDisplay().workArea;
    const limit = Math.max(1, Math.floor(area.width - WORK_AREA_MARGIN));
    return Math.max(
      MIN_SURFACE_WIDTH,
      Math.min(Math.round(requested), MAX_SURFACE_WIDTH, Math.max(limit, MIN_SURFACE_WIDTH)),
    );
  }

  function schedulePositionPersist(): void {
    if (positionPersistTimer) clearTimeout(positionPersistTimer);
    positionPersistTimer = setTimeout(() => {
      positionPersistTimer = undefined;
      if (position) host.writePosition(position);
    }, POSITION_PERSIST_DELAY_MS);
  }

  function flushPositionPersist(): void {
    if (positionPersistTimer) {
      clearTimeout(positionPersistTimer);
      positionPersistTimer = undefined;
    }
    if (position) host.writePosition(position);
  }

  function scheduleTtl(nextSpec: SurfaceSpec): void {
    const ttlMs = nextSpec.lifecycle?.ttlMs;
    if (ttlMs === undefined || ttlMs <= 0) return;
    dismissTimer = setTimeout(() => dismiss(), ttlMs);
  }

  function clearTtl(): void {
    if (dismissTimer) {
      clearTimeout(dismissTimer);
      dismissTimer = undefined;
    }
  }

  return {
    dismiss,
    getState,
    getWindow: () => windowRef,
    handleReady,
    isFromSender,
    resize,
    sendState,
    show,
  };
}

function isValidSize(size: ContentSize): boolean {
  return (
    Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0
  );
}

function clampDimension(
  requested: number,
  available: number,
  minimum: number,
  maximum: number,
): number {
  const limit = Math.max(1, Math.floor(available - WORK_AREA_MARGIN));
  return Math.max(minimum, Math.min(Math.round(requested), maximum, Math.max(limit, minimum)));
}
