import path from "node:path";
import type { ImeCandidateAction, ImeCandidateAnchor, ImeState } from "@answra/shared";
import { ImeCandidateChannels } from "@answra/shared";
import { app, BrowserWindow, screen, type WebContents } from "electron";
import { setWindowCaptureProtection } from "../windowCaptureProtection";
import { attachNonActivatingWindow } from "../windowInteractionPolicy";
import { positionImeCandidate } from "./imeCandidateLayout";

const INITIAL_SIZE = { width: 640, height: 56 };
const DEFAULT_SIZE = INITIAL_SIZE;

export function resolveImeCandidateWindowPaths(mainBundleDirectory: string) {
  return {
    preload: path.join(mainBundleDirectory, "../preload/index.cjs"),
    renderer: path.join(mainBundleDirectory, "../../dist/index.html"),
  };
}

export interface ImeCandidateWindowHost {
  isOwnerWindow(window: BrowserWindow): boolean;
  isStealthEnabled(): boolean;
}

/** Owns the native candidate surface; the focused input renderer remains the IME state owner. */
export function createImeCandidateWindowController(host: ImeCandidateWindowHost) {
  let windowRef: BrowserWindow | undefined;
  let ownerWindow: BrowserWindow | undefined;
  let ownerClosedListener: (() => void) | undefined;
  let ownerBoundsListener: (() => void) | undefined;
  let state: ImeState | undefined;
  let anchor: ImeCandidateAnchor | undefined;
  let size = DEFAULT_SIZE;
  let pageLoaded = false;
  let rendererRequestedReady = false;
  let rendererReady = false;
  let displayListenersAttached = false;

  function update(
    owner: BrowserWindow,
    payload: { state: ImeState; anchor: ImeCandidateAnchor } | null,
  ) {
    if (!host.isOwnerWindow(owner) || owner.isDestroyed()) return;
    if (!payload || !hasCandidates(payload.state)) {
      if (ownerWindow === owner) hide("owner-reported-no-candidates");
      return;
    }

    setOwner(owner);
    state = payload.state;
    anchor = payload.anchor;
    if (!windowRef || windowRef.isDestroyed()) createWindow();
    positionAndShow();
    sendState();
  }

  function setOwner(nextOwner: BrowserWindow): void {
    if (ownerWindow === nextOwner) return;
    detachOwnerListener();
    ownerWindow = nextOwner;
    ownerClosedListener = () => hide("owner-closed");
    ownerBoundsListener = () => positionAndShow();
    nextOwner.once("closed", ownerClosedListener);
    nextOwner.on("move", ownerBoundsListener);
    nextOwner.on("resize", ownerBoundsListener);
  }

  function createWindow(): void {
    attachDisplayListeners();
    const paths = resolveImeCandidateWindowPaths(__dirname);
    const created = new BrowserWindow({
      ...INITIAL_SIZE,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      webPreferences: {
        preload: paths.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    windowRef = created;
    pageLoaded = false;
    rendererRequestedReady = false;
    rendererReady = false;
    created.setAlwaysOnTop(true, "pop-up-menu");
    created.setSkipTaskbar(true);
    attachNonActivatingWindow(created);
    setWindowCaptureProtection(created, host.isStealthEnabled());
    created.on("show", () => setWindowCaptureProtection(created, host.isStealthEnabled()));
    created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    created.webContents.on("will-navigate", (event) => event.preventDefault());
    created.webContents.on("preload-error", (_event, preloadPath, error) => {
      console.error("[ime-candidate] preload failed", { preloadPath, error });
    });
    created.webContents.on("did-finish-load", () => {
      if (windowRef !== created || created.isDestroyed()) return;
      pageLoaded = true;
      activateRendererIfReady();
    });
    created.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (isMainFrame)
          console.error("[ime-candidate] renderer failed to load", {
            errorCode,
            errorDescription,
            url: validatedURL,
          });
      },
    );
    created.on("show", () => {
      console.info("[ime-candidate] window shown", {
        windowId: created.id,
        bounds: created.getBounds(),
        ownerWindowId: ownerWindow?.id,
      });
    });
    created.on("hide", () => {
      console.info("[ime-candidate] window hidden", { windowId: created.id });
    });
    created.on("closed", () => {
      if (windowRef !== created) return;
      hide("candidate-window-closed");
      detachDisplayListeners();
      windowRef = undefined;
      pageLoaded = false;
      rendererRequestedReady = false;
      rendererReady = false;
    });
    const loading = app.isPackaged
      ? created.loadFile(paths.renderer, {
          query: { surface: "ime-candidate" },
        })
      : created.loadURL("http://127.0.0.1:5180/?surface=ime-candidate");
    void loading.catch((error: unknown) =>
      console.error("[ime-candidate] renderer navigation failed", error),
    );
  }

  function positionAndShow(): void {
    const window = windowRef;
    const source = ownerWindow;
    if (
      !rendererReady ||
      !window ||
      window.isDestroyed() ||
      !source ||
      source.isDestroyed() ||
      !anchor
    )
      return;
    const sourceBounds = source.getContentBounds();
    const screenAnchor = {
      x: sourceBounds.x + anchor.x,
      lineTop: sourceBounds.y + anchor.lineTop,
      lineBottom: sourceBounds.y + anchor.lineBottom,
    };
    const display = screen.getDisplayNearestPoint({
      x: screenAnchor.x,
      y: screenAnchor.lineBottom,
    });
    const bounds = positionImeCandidate(screenAnchor, display.workArea, size);
    window.setBounds(
      { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      false,
    );
    if (!window.isVisible()) window.showInactive();
  }

  function resize(nextSize: { width: number; height: number }): void {
    if (!isValidSize(nextSize)) return;
    size = nextSize;
    positionAndShow();
  }

  function sendState(): void {
    if (!pageLoaded || !rendererReady || !windowRef || windowRef.isDestroyed()) return;
    if (state) windowRef.webContents.send(ImeCandidateChannels.State, state);
  }

  function markRendererReady(): void {
    rendererRequestedReady = true;
    activateRendererIfReady();
  }

  function activateRendererIfReady(): void {
    if (!pageLoaded || !rendererRequestedReady || !windowRef || windowRef.isDestroyed()) return;
    rendererReady = true;
    sendState();
    positionAndShow();
  }

  function routeAction(action: ImeCandidateAction): void {
    if (!state || !ownerWindow || ownerWindow.isDestroyed()) return;
    ownerWindow.webContents.send(ImeCandidateChannels.OwnerAction, action);
  }

  function isCandidateContents(contents: WebContents): boolean {
    return !!windowRef && !windowRef.isDestroyed() && contents === windowRef.webContents;
  }

  function hide(reason: string): void {
    if (windowRef && !windowRef.isDestroyed()) {
      const wasVisible = windowRef.isVisible();
      console.info("[ime-candidate] hide requested", {
        windowId: windowRef.id,
        reason,
        wasVisible,
      });
      if (wasVisible) windowRef.hide();
    }
    detachOwnerListener();
    ownerWindow = undefined;
    state = undefined;
    anchor = undefined;
  }

  function setCaptureProtection(enabled: boolean): void {
    if (windowRef && !windowRef.isDestroyed()) setWindowCaptureProtection(windowRef, enabled);
  }

  function detachOwnerListener(): void {
    if (ownerWindow && ownerClosedListener && !ownerWindow.isDestroyed()) {
      ownerWindow.removeListener("closed", ownerClosedListener);
    }
    if (ownerWindow && ownerBoundsListener && !ownerWindow.isDestroyed()) {
      ownerWindow.removeListener("move", ownerBoundsListener);
      ownerWindow.removeListener("resize", ownerBoundsListener);
    }
    ownerClosedListener = undefined;
    ownerBoundsListener = undefined;
  }

  function dispose(): void {
    detachDisplayListeners();
    hide("controller-disposed");
    if (windowRef && !windowRef.isDestroyed()) windowRef.close();
    windowRef = undefined;
    pageLoaded = false;
    rendererRequestedReady = false;
    rendererReady = false;
  }

  function attachDisplayListeners(): void {
    if (displayListenersAttached) return;
    screen.on("display-metrics-changed", positionAndShow);
    screen.on("display-added", positionAndShow);
    screen.on("display-removed", positionAndShow);
    displayListenersAttached = true;
  }

  function detachDisplayListeners(): void {
    if (!displayListenersAttached) return;
    screen.removeListener("display-metrics-changed", positionAndShow);
    screen.removeListener("display-added", positionAndShow);
    screen.removeListener("display-removed", positionAndShow);
    displayListenersAttached = false;
  }

  return {
    dispose,
    isCandidateContents,
    resize,
    routeAction,
    markRendererReady,
    sendState,
    setCaptureProtection,
    update,
  };
}

function hasCandidates(state: ImeState): boolean {
  return state.enabled && (state.preedit.length > 0 || state.candidates.length > 0);
}

function isValidSize(size: { width: number; height: number }): boolean {
  return (
    Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0
  );
}
