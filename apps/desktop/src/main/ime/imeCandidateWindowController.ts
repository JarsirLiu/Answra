import path from "node:path";
import type { ImeCandidateAction, ImeCandidateAnchor, ImeState } from "@answra/shared";
import { ImeCandidateChannels } from "@answra/shared";
import { app, BrowserWindow, screen, type WebContents } from "electron";
import { getWindowCaptureDiagnostics } from "../windowCaptureProtection";
import { isCurrentProcessForeground } from "../windowForeground";
import type { WindowSurfaceDescriptor } from "../windowSurfaceRegistry";
import {
  type ImeCandidateScreenAnchor,
  type ImeCandidateWindowBounds,
  positionImeCandidate,
} from "./imeCandidateLayout";
import { logImeDiagnostic } from "./imeDiagnostics";

const INITIAL_SIZE = { width: 640, height: 56 };
const DEFAULT_SIZE = INITIAL_SIZE;

export type ImeCandidatePresentationUpdate =
  | {
      type: "show";
      state: ImeState;
      anchor: ImeCandidateAnchor;
      targetId: string;
      generation: number;
    }
  | { type: "suspend"; targetId?: string; generation?: number }
  | { type: "clear"; state?: ImeState; targetId?: string; generation?: number };

export function resolveImeCandidateWindowPaths(mainBundleDirectory: string) {
  return {
    preload: path.join(mainBundleDirectory, "../preload/index.cjs"),
    renderer: path.join(mainBundleDirectory, "../../dist/index.html"),
  };
}

export interface ImeCandidateWindowHost {
  isOwnerWindow(window: BrowserWindow): boolean;
  registerWindowSurface: (window: BrowserWindow, descriptor: WindowSurfaceDescriptor) => void;
  prepareWindowToShow: (window: BrowserWindow) => boolean;
  attachAbove: (child: BrowserWindow, owner: BrowserWindow) => void;
  subscribeFocus?: (
    listener: (event: { window: BrowserWindow; focused: boolean; visible: boolean }) => void,
  ) => () => void;
}

/**
 * Candidate presentation facts are split into independent writers so a change in one
 * domain cannot silently rewrite another (the S1 root cause: several writers for one
 * fact). Each slot below has exactly one mutating entry point:
 *
 * - `content` (engine state + owner/target/generation identity) -> `setContent`/`clearContent`
 * - `anchor` (composition caret geometry)                       -> `setAnchor`/`clearAnchor`
 * - window lifecycle (`window`/`pageLoaded`/ready flags)        -> `createWindow`/`resetWindowLifecycle`
 * - owner binding (`ownerWindow` + listeners + z-order)         -> `bindOwner`/`unbindOwner`
 * - `size` (renderer-reported, unclamped content size)          -> `setSize`
 * - capture protection                                          -> `host.registerWindowSurface` at creation
 *
 * `hide`/`suspend` compose those writers; they no longer clear every domain through
 * one shared batch.
 */
export function createImeCandidateWindowController(host: ImeCandidateWindowHost) {
  // Candidate content: the engine snapshot plus the lease identity it belongs to.
  // Kept in one value so identity (targetId/generation) and state cannot diverge.
  let content: CandidateContent | undefined;
  // Composition caret geometry reported by the owning editor adapter.
  let anchor: ImeCandidateAnchor | undefined;
  // Native window lifecycle.
  let windowRef: BrowserWindow | undefined;
  let pageLoaded = false;
  let rendererRequestedReady = false;
  let rendererReady = false;
  // Owner binding: the input window this surface is attached above.
  let ownerWindow: BrowserWindow | undefined;
  let ownerClosedListener: (() => void) | undefined;
  let ownerFocusUnsubscribe: (() => void) | undefined;
  let ownerBoundsListener: (() => void) | undefined;
  // Renderer-reported, unclamped content size; the only size writer is `resize`.
  let size = DEFAULT_SIZE;
  let displayListenersAttached = false;
  let lastPositionStatus = "";
  let lastNativePositionSignature = "";
  let anchorLeaseKey: string | undefined;
  let anchorReportedAvailable = false;

  function update(owner: BrowserWindow, payload: ImeCandidatePresentationUpdate) {
    if (!host.isOwnerWindow(owner) || owner.isDestroyed()) return;
    if (payload.type === "suspend") {
      if (!matchesCandidate(owner, payload.targetId, payload.generation)) return;
      suspend(owner, "owner-suspended");
      return;
    }
    if (payload.type === "clear") {
      if (!matchesCandidate(owner, payload.targetId, payload.generation)) return;
      if (payload.state?.enabled && payload.state.composing) {
        suspend(owner, "owner-reported-composition-active-without-candidates");
        return;
      }
      logImeDiagnostic("candidate-update-clear", {
        windowId: owner.id,
        targetId: payload.targetId,
        generation: payload.generation,
        reason: "owner-reported-no-candidates",
        state: payload.state,
      });
      if (payload.targetId && payload.generation !== undefined)
        reportAnchorUnavailable(owner, payload.targetId, payload.generation, "clear");
      if (ownerWindow === owner) hide("owner-reported-no-candidates");
      return;
    }
    if (!hasCandidates(payload.state)) {
      if (ownerWindow === owner) hide("owner-reported-no-candidates");
      logImeDiagnostic("candidate-update-empty", {
        windowId: owner.id,
        targetId: payload.targetId,
        generation: payload.generation,
        composing: payload.state.composing,
        preedit: payload.state.preedit,
        candidates: payload.state.candidates,
      });
      return;
    }

    bindOwner(owner);
    setContent({
      state: payload.state,
      targetId: payload.targetId,
      generation: payload.generation,
    });
    setAnchor(payload.anchor);
    reportAnchorAvailable(owner, payload.targetId, payload.generation, payload.anchor);
    if (!windowRef || windowRef.isDestroyed()) createWindow();
    positionAndShow();
    sendState();
    logImeDiagnostic("candidate-update-show", {
      windowId: owner.id,
      targetId: payload.targetId,
      generation: payload.generation,
      preedit: payload.state.preedit,
      candidates: payload.state.candidates,
      anchorX: Math.round(payload.anchor.x),
      anchorY: Math.round(payload.anchor.lineBottom),
    });
  }

  function matchesCandidate(
    owner: BrowserWindow,
    nextTargetId: string | undefined,
    nextGeneration: number | undefined,
  ): boolean {
    return (
      nextTargetId !== undefined &&
      nextGeneration !== undefined &&
      ownerWindow === owner &&
      content?.targetId === nextTargetId &&
      content.generation === nextGeneration
    );
  }

  // --- content writer ---
  function setContent(next: CandidateContent): void {
    content = next;
  }
  function clearContent(): void {
    content = undefined;
  }

  // --- anchor writer ---
  function setAnchor(next: ImeCandidateAnchor): void {
    anchor = next;
  }
  function clearAnchor(): void {
    anchor = undefined;
  }

  // --- size writer (renderer-reported, unclamped) ---
  function setSize(next: { width: number; height: number }): void {
    if (!isValidSize(next)) return;
    size = next;
    positionAndShow();
  }

  // --- window lifecycle writer ---
  function resetWindowLifecycle(): void {
    pageLoaded = false;
    rendererRequestedReady = false;
    rendererReady = false;
  }

  // --- owner binding writer ---
  function bindOwner(nextOwner: BrowserWindow): void {
    if (ownerWindow === nextOwner) return;
    unbindOwner();
    ownerWindow = nextOwner;
    if (windowRef && !windowRef.isDestroyed()) host.attachAbove(windowRef, nextOwner);
    ownerClosedListener = () => {
      if (content)
        reportAnchorUnavailable(nextOwner, content.targetId, content.generation, "owner-closed");
      hide("owner-closed");
    };
    ownerFocusUnsubscribe = host.subscribeFocus?.(({ window, focused }) => {
      if (window !== nextOwner || !focused) return;
      const candidate = windowRef;
      const focusedWindow = BrowserWindow.getFocusedWindow();
      logImeDiagnostic("candidate-owner-focus", {
        ownerWindowId: nextOwner.id,
        targetId: content?.targetId,
        generation: content?.generation,
        hasAnchor: anchor !== undefined,
        anchor: anchor
          ? {
              x: Math.round(anchor.x),
              lineTop: Math.round(anchor.lineTop),
              lineBottom: Math.round(anchor.lineBottom),
            }
          : undefined,
        candidateWindowId: candidate?.isDestroyed() ? undefined : candidate?.id,
        candidateVisible: candidate && !candidate.isDestroyed() ? candidate.isVisible() : false,
        candidateAlwaysOnTop:
          candidate && !candidate.isDestroyed() ? candidate.isAlwaysOnTop() : false,
        candidateBounds: candidate && !candidate.isDestroyed() ? candidate.getBounds() : undefined,
        focusedWindowId: focusedWindow?.id,
        appForeground: isCurrentProcessForeground(),
      });
    });
    ownerBoundsListener = () => positionAndShow();
    nextOwner.once("closed", ownerClosedListener);
    nextOwner.on("move", ownerBoundsListener);
    nextOwner.on("resize", ownerBoundsListener);
  }

  function unbindOwner(): void {
    if (ownerWindow && ownerClosedListener && !ownerWindow.isDestroyed()) {
      ownerWindow.removeListener("closed", ownerClosedListener);
    }
    ownerFocusUnsubscribe?.();
    if (ownerWindow && ownerBoundsListener && !ownerWindow.isDestroyed()) {
      ownerWindow.removeListener("move", ownerBoundsListener);
      ownerWindow.removeListener("resize", ownerBoundsListener);
    }
    ownerClosedListener = undefined;
    ownerBoundsListener = undefined;
    ownerFocusUnsubscribe = undefined;
    ownerWindow = undefined;
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
    logImeDiagnostic("candidate-window-created", {
      windowId: created.id,
      ownerWindowId: ownerWindow?.id,
      focusable: false,
      stealthPolicyExpected: true,
    });
    windowRef = created;
    host.registerWindowSurface(created, {
      role: "ime-candidate",
      captureProtection: "stealth-only",
      failClosed: true,
    });
    if (ownerWindow && !ownerWindow.isDestroyed()) host.attachAbove(created, ownerWindow);
    resetWindowLifecycle();
    created.setSkipTaskbar(true);
    created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    created.webContents.on("will-navigate", (event) => event.preventDefault());
    created.webContents.on("preload-error", (_event, preloadPath, error) => {
      console.error("[ime-candidate] preload failed", { preloadPath, error });
    });
    created.webContents.on("did-finish-load", () => {
      if (windowRef !== created || created.isDestroyed()) return;
      pageLoaded = true;
      logImeDiagnostic("candidate-renderer-page-loaded", {
        windowId: created.id,
        rendererRequestedReady,
      });
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
      reportNativeWindow("candidate-native-show", {
        state: content?.state
          ? {
              composing: content.state.composing,
              preedit: content.state.preedit,
              candidates: content.state.candidates,
            }
          : undefined,
      });
    });
    created.on("hide", () => {
      logImeDiagnostic("candidate-window-hidden", {
        windowId: created.id,
        ownerWindowId: ownerWindow?.id,
        targetId: content?.targetId,
        generation: content?.generation,
      });
    });
    created.on("closed", () => {
      if (windowRef !== created) return;
      hide("candidate-window-closed");
      detachDisplayListeners();
      windowRef = undefined;
      resetWindowLifecycle();
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

  // Resolve where the surface should sit. Pure geometry: reads owner/anchor/size,
  // reports why it cannot proceed, but never changes visibility or z-order.
  function computeCandidateFrame(): CandidateFrame | undefined {
    const window = windowRef;
    const source = ownerWindow;
    if (!rendererReady || !window || window.isDestroyed()) {
      reportPositionStatus("renderer-not-ready", {
        windowId: window?.id,
        pageLoaded,
        rendererRequestedReady,
      });
      return undefined;
    }
    if (!source || source.isDestroyed()) {
      reportPositionStatus("owner-unavailable", { windowId: window.id });
      return undefined;
    }
    if (!anchor) {
      reportPositionStatus("anchor-unavailable", {
        windowId: window.id,
        targetId: content?.targetId,
        generation: content?.generation,
      });
      return undefined;
    }
    const ownerContentBounds = source.getContentBounds();
    const screenAnchor = {
      x: ownerContentBounds.x + anchor.x,
      lineTop: ownerContentBounds.y + anchor.lineTop,
      lineBottom: ownerContentBounds.y + anchor.lineBottom,
    };
    const display = screen.getDisplayNearestPoint({
      x: screenAnchor.x,
      y: screenAnchor.lineBottom,
    });
    return {
      window,
      owner: source,
      screenAnchor,
      ownerContentBounds,
      display,
      bounds: positionImeCandidate(screenAnchor, display.workArea, size),
    };
  }

  // Sole geometry writer: place the surface at the resolved frame.
  function applyCandidateGeometry(frame: CandidateFrame): void {
    const { bounds } = frame;
    frame.window.setBounds(
      { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      false,
    );
    reportNativeWindow("candidate-native-positioned", {
      targetId: content?.targetId,
      generation: content?.generation,
      anchor: frame.screenAnchor,
      ownerContentBounds: frame.ownerContentBounds,
      requestedSize: size,
      candidateBounds: bounds,
      rendererReady,
    });
  }

  // Sole visibility/z-order writer: reveal the surface above its owner, or re-assert
  // z-order when it is already visible.
  function presentCandidate(frame: CandidateFrame): void {
    const { window, owner, bounds } = frame;
    if (window.isVisible()) {
      // 已可见时也要重新断言 z 序：owner 被 setBounds/激活后，
      // Windows 不会自动保持 owned 候选窗口在 owner 之上。
      host.attachAbove(window, owner);
      reportPositionStatus("already-visible", {
        windowId: window.id,
        bounds: JSON.stringify(bounds),
      });
      return;
    }
    if (!host.prepareWindowToShow(window)) {
      reportNativeWindow("candidate-native-show-denied", {
        targetId: content?.targetId,
        generation: content?.generation,
        reason: "prepare-to-show-denied",
        stealth: true,
      });
      reportPositionStatus("prepare-to-show-denied", {
        windowId: window.id,
        stealth: true,
        bounds: JSON.stringify(bounds),
      });
      return;
    }
    window.showInactive();
    reportPositionStatus(window.isVisible() ? "show-request-visible" : "show-request-not-visible", {
      windowId: window.id,
      bounds: JSON.stringify(bounds),
      ownerWindowId: owner.id,
    });
  }

  function positionAndShow(): void {
    const frame = computeCandidateFrame();
    if (!frame) return;
    if (frame.bounds.height === 0) {
      hideWindow("no-space-below-composition-caret");
      reportPositionStatus("no-space-below-composition-caret", {
        windowId: frame.window.id,
        targetId: content?.targetId,
        generation: content?.generation,
        anchorX: Math.round(frame.screenAnchor.x),
        anchorY: Math.round(frame.screenAnchor.lineBottom),
        workAreaX: frame.display.workArea.x,
        workAreaY: frame.display.workArea.y,
        workAreaWidth: frame.display.workArea.width,
        workAreaHeight: frame.display.workArea.height,
      });
      return;
    }
    applyCandidateGeometry(frame);
    presentCandidate(frame);
  }

  function sendState(): void {
    if (!pageLoaded || !rendererReady || !windowRef || windowRef.isDestroyed()) return;
    if (content) {
      windowRef.webContents.send(ImeCandidateChannels.State, {
        state: content.state,
        targetId: content.targetId,
        generation: content.generation,
      });
      logImeDiagnostic("candidate-state-sent", {
        windowId: windowRef.id,
        targetId: content.targetId,
        generation: content.generation,
        composing: content.state.composing,
        preedit: content.state.preedit,
        candidates: content.state.candidates,
        selectedIndex: content.state.selectedIndex,
        page: content.state.page,
      });
    }
  }

  function markRendererReady(): void {
    rendererRequestedReady = true;
    logImeDiagnostic("candidate-renderer-ready-request", {
      windowId: windowRef?.id,
      pageLoaded,
      rendererReady,
    });
    activateRendererIfReady();
  }

  function activateRendererIfReady(): void {
    if (!pageLoaded || !rendererRequestedReady || !windowRef || windowRef.isDestroyed()) return;
    rendererReady = true;
    logImeDiagnostic("candidate-renderer-ready", {
      windowId: windowRef.id,
      pageLoaded,
      hasState: content !== undefined,
      hasAnchor: anchor !== undefined,
      targetId: content?.targetId,
      generation: content?.generation,
    });
    sendState();
    positionAndShow();
  }

  function routeAction(action: ImeCandidateAction): void {
    if (
      !content ||
      !anchor ||
      !windowRef ||
      windowRef.isDestroyed() ||
      !windowRef.isVisible() ||
      !ownerWindow ||
      ownerWindow.isDestroyed() ||
      action.targetId !== content.targetId ||
      action.generation !== content.generation
    )
      return;
    ownerWindow.webContents.send(ImeCandidateChannels.OwnerAction, action);
  }

  function isCandidateContents(contents: WebContents): boolean {
    return !!windowRef && !windowRef.isDestroyed() && contents === windowRef.webContents;
  }

  function hide(reason: string): void {
    hideWindow(reason);
    unbindOwner();
    clearContent();
    clearAnchor();
  }

  function suspend(owner: BrowserWindow, reason: string): void {
    if (ownerWindow !== owner) return;
    if (anchor === undefined && (!windowRef || windowRef.isDestroyed() || !windowRef.isVisible()))
      return;
    if (content) reportAnchorUnavailable(owner, content.targetId, content.generation, reason);
    hideWindow(reason);
    clearAnchor();
  }

  function hideWindow(reason: string): void {
    if (windowRef && !windowRef.isDestroyed()) {
      const wasVisible = windowRef.isVisible();
      reportNativeWindow("candidate-native-hide-requested", {
        targetId: content?.targetId,
        generation: content?.generation,
        reason,
        wasVisible,
        state: content?.state
          ? {
              enabled: content.state.enabled,
              composing: content.state.composing,
              preedit: content.state.preedit,
              candidates: content.state.candidates,
            }
          : undefined,
      });
      if (wasVisible) windowRef.hide();
      reportNativeWindow("candidate-native-hide-result", {
        targetId: content?.targetId,
        generation: content?.generation,
        reason,
        wasVisible,
      });
    }
  }

  function reportNativeWindow(event: string, details: Record<string, unknown> = {}): void {
    const window = windowRef;
    if (!window || window.isDestroyed()) return;
    const bounds = window.getBounds();
    const display = screen.getDisplayNearestPoint({
      x: bounds.x + Math.round(bounds.width / 2),
      y: bounds.y + Math.round(bounds.height / 2),
    });
    const focusedWindow = BrowserWindow.getFocusedWindow();
    const protection = getWindowCaptureDiagnostics(window);
    const snapshot = {
      windowId: window.id,
      ownerWindowId: ownerWindow?.id,
      targetId: content?.targetId,
      generation: content?.generation,
      nativeHandle: protection.nativeHandle,
      bounds,
      contentBounds: window.getContentBounds(),
      visible: window.isVisible(),
      minimized: window.isMinimized(),
      focused: window.isFocused(),
      focusedWindowId: focusedWindow?.id,
      alwaysOnTop: window.isAlwaysOnTop(),
      focusable: window.isFocusable(),
      ownerVisible: ownerWindow && !ownerWindow.isDestroyed() ? ownerWindow.isVisible() : undefined,
      ownerFocused: ownerWindow && !ownerWindow.isDestroyed() ? ownerWindow.isFocused() : undefined,
      appForeground: isCurrentProcessForeground(),
      display: {
        id: display.id,
        bounds: display.bounds,
        workArea: display.workArea,
        scaleFactor: display.scaleFactor,
      },
      captureProtection: {
        reportedProtected: protection.reportedProtected,
        protectionBounds: protection.bounds,
        protectionVisible: protection.visible,
      },
      ...details,
    };

    if (event === "candidate-native-positioned") {
      const signature = JSON.stringify({
        targetId: content?.targetId,
        generation: content?.generation,
        bounds,
        requestedSize: size,
        visible: snapshot.visible,
        minimized: snapshot.minimized,
        focused: snapshot.focused,
        focusedWindowId: snapshot.focusedWindowId,
        alwaysOnTop: snapshot.alwaysOnTop,
        ownerVisible: snapshot.ownerVisible,
        ownerFocused: snapshot.ownerFocused,
        appForeground: snapshot.appForeground,
        reportedProtected: protection.reportedProtected,
      });
      if (signature === lastNativePositionSignature) return;
      lastNativePositionSignature = signature;
    }

    logImeDiagnostic(event, snapshot);
  }

  function reportPositionStatus(
    status: string,
    details: Record<string, string | number | boolean | null | undefined>,
  ) {
    if (lastPositionStatus === status) return;
    lastPositionStatus = status;
    logImeDiagnostic("candidate-position-status", { status, ...details });
  }

  function reportAnchorAvailable(
    owner: BrowserWindow,
    nextTargetId: string,
    nextGeneration: number,
    nextAnchor: ImeCandidateAnchor,
  ): void {
    const nextLeaseKey = `${owner.id}:${nextTargetId}:${nextGeneration}`;
    if (anchorLeaseKey === nextLeaseKey && anchorReportedAvailable) return;
    anchorLeaseKey = nextLeaseKey;
    anchorReportedAvailable = true;
    logImeDiagnostic("candidate-anchor", {
      state: "available",
      windowId: owner.id,
      targetId: nextTargetId,
      generation: nextGeneration,
      x: Math.round(nextAnchor.x),
      lineTop: Math.round(nextAnchor.lineTop),
      lineBottom: Math.round(nextAnchor.lineBottom),
    });
  }

  function reportAnchorUnavailable(
    owner: BrowserWindow,
    nextTargetId: string,
    nextGeneration: number,
    reason: string,
  ): void {
    const nextLeaseKey = `${owner.id}:${nextTargetId}:${nextGeneration}`;
    if (anchorLeaseKey !== nextLeaseKey || !anchorReportedAvailable) return;
    anchorReportedAvailable = false;
    logImeDiagnostic("candidate-anchor", {
      state: "unavailable",
      windowId: owner.id,
      targetId: nextTargetId,
      generation: nextGeneration,
      reason,
    });
  }

  function dispose(): void {
    detachDisplayListeners();
    hide("controller-disposed");
    if (windowRef && !windowRef.isDestroyed()) windowRef.close();
    windowRef = undefined;
    resetWindowLifecycle();
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
    resize: setSize,
    routeAction,
    warmup: createWindow,
    markRendererReady,
    sendState,
    update,
    /** Live candidate window, if created and not destroyed; used to push shared theme payloads. */
    getWindow: () => (windowRef && !windowRef.isDestroyed() ? windowRef : undefined),
  };
}

type CandidateContent = {
  readonly state: ImeState;
  readonly targetId: string;
  readonly generation: number;
};

type CandidateFrame = {
  window: BrowserWindow;
  owner: BrowserWindow;
  screenAnchor: ImeCandidateScreenAnchor;
  ownerContentBounds: ReturnType<BrowserWindow["getContentBounds"]>;
  display: ReturnType<typeof screen.getDisplayNearestPoint>;
  bounds: ImeCandidateWindowBounds;
};

function hasCandidates(state: ImeState): boolean {
  return state.enabled && (state.preedit.length > 0 || state.candidates.length > 0);
}

function isValidSize(size: { width: number; height: number }): boolean {
  return (
    Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0
  );
}
