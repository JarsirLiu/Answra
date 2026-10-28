import {
  ImeChannels,
  type ImeKeyRequest,
  type ImeLeaseResponse,
  type ImeSessionCommand,
  type ImeSessionCommandResult,
  type ImeSessionSnapshot,
  type ImeState,
} from "@answra/shared";
import { BrowserWindow, ipcMain } from "electron";
import {
  getReplyBarWindow,
  getWindow,
  isImeCandidateWindowFromSender,
  isStealthEnabled,
  isWindowFromSender,
  setImeCandidateState,
  subscribeToWindowFocus,
} from "../window";
import { describeForegroundWindow, isCurrentProcessForeground } from "../windowForeground";
import { isolateNativeIme } from "../windowStealthController";
import { isImeDebugEnabled, logImeDiagnostic } from "./imeDiagnostics";
import { createImeRendererDiagnosticHandler } from "./imeRendererDiagnostics";
import { ImeSessionManager, isActiveImeLease } from "./imeSessionManager";
import type { ImeOwnerIdentity, ImeSessionState } from "./imeSessionState";
import { RimeBridge } from "./rimeBridge";

const EMPTY_STATE: ImeState = {
  enabled: false,
  inputMode: "chinese",
  composing: false,
  preedit: "",
  candidates: [],
  selectedIndex: 0,
  page: 0,
  hasNextPage: false,
};

const BLUR_SETTLE_MS = 120;

export function registerImeIpc(): {
  dispose: () => void;
  available: boolean;
  isCurrentLease: (owner: BrowserWindow, targetId: string, generation: number) => boolean;
  getSessionSnapshot: () => ImeSessionSnapshot;
} {
  const bridge = new RimeBridge();
  const manager = new ImeSessionManager(bridge);
  let leaseWindow: BrowserWindow | undefined;
  const releaseLeaseAfterCaptureStop = (reason: string): void => {
    const lease = manager.lease;
    const window = leaseWindow;
    if (
      (lease.status !== "owned" && lease.status !== "suspended") ||
      !window ||
      window.isDestroyed() ||
      window.webContents.isDestroyed()
    )
      return;
    const owner = lease.owner;
    const generation = lease.generation;
    void manager.serialize(async () => {
      const current = manager.lease;
      if (
        (current.status !== "owned" && current.status !== "suspended") ||
        current.generation !== generation ||
        current.owner.windowId !== owner.windowId ||
        current.owner.webContentsId !== owner.webContentsId ||
        current.owner.targetId !== owner.targetId
      )
        return;
      manager.transition({ type: "release", owner, generation });
      setImeCandidateState(window, { type: "clear", targetId: owner.targetId, generation });
      detachLeaseListeners();
      if (bridge.snapshot.composing) await manager.resetComposition();
      logImeDiagnostic("lease-released", {
        windowId: owner.windowId,
        targetId: owner.targetId,
        generation,
        reason,
        composing: bridge.snapshot.composing,
      });
      publishSnapshot();
    });
  };
  const unsubscribeKeyboardCapture = bridge.onKeyboardCaptureEvent((captured) => {
    if (captured.type === "stopped") {
      if (captured.reason !== "released" && captured.reason !== "shutdown") {
        logImeDiagnostic("keyboard-capture-stopped", {
          reason: captured.reason,
          generation: manager.lease.generation,
          targetId: manager.lease.status === "owned" ? manager.lease.owner.targetId : undefined,
        });
        releaseLeaseAfterCaptureStop(`keyboard-capture-${captured.reason}`);
      }
      return;
    }
    const lease = manager.lease;
    const window = leaseWindow;
    if (
      lease.status !== "owned" ||
      captured.generation !== lease.generation ||
      !window ||
      window.isDestroyed() ||
      window.webContents.isDestroyed() ||
      lease.owner.windowId !== window.id ||
      lease.owner.webContentsId !== window.webContents.id
    )
      return;
    window.webContents.send(ImeChannels.KeyboardInput, {
      targetId: lease.owner.targetId,
      generation: lease.generation,
      type: captured.release ? "keyup" : "keydown",
      eventId: captured.eventId,
      key: captured.key,
      code: captured.code,
      shift: captured.shift,
      ctrl: captured.ctrl,
      alt: captured.alt,
      meta: captured.meta,
      repeat: captured.repeat,
    });
  });
  let blurTimer: ReturnType<typeof setTimeout> | undefined;
  let leaseListeners: Array<() => void> = [];
  let lastPublishedRevision = -1;
  const commandResults = new Map<
    string,
    { fingerprint: string; result: ImeSessionCommandResult }
  >();
  const serialize = <T>(operation: () => Promise<T>, expectedRevision?: number) =>
    manager.serialize(async () => {
      if (expectedRevision !== undefined && manager.snapshot.revision !== expectedRevision)
        throw new StaleImeRevisionError();
      return operation();
    });
  const handle = (
    channel: string,
    listener: (event: Electron.IpcMainInvokeEvent, payload: unknown) => unknown,
  ) => {
    const wrapped = async (event: Electron.IpcMainInvokeEvent, payload: unknown) => {
      const result = await listener(event, payload);
      publishSnapshot();
      return result;
    };
    ipcMain.handle(channel, wrapped);
  };
  const publishSnapshot = () => {
    const snapshot = manager.snapshot;
    if (snapshot.revision === lastPublishedRevision) return;
    lastPublishedRevision = snapshot.revision;
    for (const window of [getWindow(), getReplyBarWindow()]) {
      if (window && !window.isDestroyed())
        window.webContents.send(ImeChannels.SessionSnapshot, { snapshot });
    }
  };
  const windowFor = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => {
    const main = getWindow();
    if (main && isWindowFromSender(main, event)) return main;
    const reply = getReplyBarWindow();
    return reply && isWindowFromSender(reply, event) ? reply : undefined;
  };
  const ownerFor = (
    event: Electron.IpcMainInvokeEvent,
    targetId: string,
  ): ImeOwnerIdentity | undefined => {
    const window = windowFor(event);
    if (!window || !isTargetId(targetId)) return undefined;
    return { windowId: window.id, webContentsId: event.sender.id, targetId };
  };
  const matchesCurrent = (
    event: Electron.IpcMainInvokeEvent,
    generation: number,
    allowSuspended = false,
  ) => {
    const window = windowFor(event);
    if (
      !window ||
      (manager.lease.status !== "owned" &&
        !(allowSuspended && manager.lease.status === "suspended"))
    )
      return undefined;
    if (
      manager.lease.generation !== generation ||
      manager.lease.owner.windowId !== window.id ||
      manager.lease.owner.webContentsId !== event.sender.id
    )
      return undefined;
    return { window, owner: manager.lease.owner };
  };

  const onRendererDiagnostic = createImeRendererDiagnosticHandler({
    isCandidateWindowFromSender: isImeCandidateWindowFromSender,
    getCandidateWindow: (event) => BrowserWindow.fromWebContents(event.sender) ?? undefined,
    getOwnerWindow: windowFor,
    isDebugEnabled: isImeDebugEnabled,
    log: logImeDiagnostic,
  });
  ipcMain.on(ImeChannels.Diagnostic, onRendererDiagnostic);

  function detachLeaseListeners(): void {
    for (const detach of leaseListeners) detach();
    leaseListeners = [];
    leaseWindow = undefined;
    if (blurTimer) clearTimeout(blurTimer);
    blurTimer = undefined;
    void bridge.stopKeyboardCapture().catch((error: unknown) => {
      console.warn("[ime] keyboard capture stop failed", error);
    });
  }

  async function ensureKeyboardCapture(): Promise<boolean> {
    if (process.platform !== "win32") return true;
    const generation = manager.lease.status === "owned" ? manager.lease.generation : undefined;
    if (generation === undefined) return false;
    const started = await bridge.startKeyboardCapture(generation, nativeWindowHandle(leaseWindow));
    if (!started) logImeDiagnostic("keyboard-capture-unavailable", { platform: process.platform });
    return started;
  }

  function suspendCurrent(reason: string): void {
    if (manager.lease.status !== "owned" || !leaseWindow || leaseWindow.isDestroyed()) return;
    const owner = manager.lease.owner;
    const generation = manager.lease.generation;
    manager.transition({ type: "suspend", owner, generation });
    setImeCandidateState(leaseWindow, { type: "suspend", targetId: owner.targetId, generation });
    logImeDiagnostic("lease-suspended", { windowId: owner.windowId, generation, reason });
    publishSnapshot();
  }

  function attachLeaseListeners(
    window: BrowserWindow,
    owner: ImeOwnerIdentity,
    generation: number,
  ): void {
    detachLeaseListeners();
    leaseWindow = window;
    // Capture the channels object: reading `window.webContents` after the window is
    // destroyed throws "Object has been destroyed", and both `closed` and app quit
    // detach the listeners while the owner may already be gone.
    const contents = window.webContents;
    const onBlur = () => {
      // A stealth lease is deliberately owned while another application remains
      // foreground. BrowserWindow blur is therefore expected and must not revoke
      // the native keyboard route.
      if (isStealthEnabled()) return;
      if (blurTimer) clearTimeout(blurTimer);
      blurTimer = setTimeout(() => {
        if (
          leaseWindow !== window ||
          window.isDestroyed() ||
          manager.lease.status !== "owned" ||
          manager.lease.generation !== generation
        )
          return;
        const focused = BrowserWindow.getFocusedWindow();
        if (isCurrentProcessForeground() && (!focused || focused === window)) return;
        logImeDiagnostic("owner-blur-settled", {
          windowId: window.id,
          generation,
          focusedWindowId: focused?.id,
          appForeground: isCurrentProcessForeground(),
          ...describeForegroundWindow(),
          processId: process.pid,
        });
        suspendCurrent("owner-window-blur");
      }, BLUR_SETTLE_MS);
    };
    const onFocus = () => {
      if (blurTimer) clearTimeout(blurTimer);
      blurTimer = undefined;
      // Stealth owns native IME isolation. After leaving stealth the window is
      // focusable again and regaining focus must not detach the system IME.
      if (!isStealthEnabled()) return;
      if (isolateNativeIme(window) === "failed") {
        suspendCurrent("native-ime-isolation-failed-on-focus");
        logImeDiagnostic("native-ime-isolation-failed-on-focus", {
          windowId: window.id,
          generation,
        });
      }
    };
    const onClosed = () => releaseOwnedLease("owner-window-closed");
    const onGone = () => releaseOwnedLease("renderer-process-gone");
    const releaseOwnedLease = (reason: string) => {
      const currentWindow = findWindow(owner.windowId);
      if (currentWindow)
        setImeCandidateState(currentWindow, {
          type: "clear",
          targetId: owner.targetId,
          generation,
        });
      const active = manager.lease;
      if (isActiveImeLease(active)) {
        logImeDiagnostic("lease-released", {
          windowId: owner.windowId,
          targetId: active.owner.targetId,
          generation: active.generation,
          reason,
          staleListener: active.generation !== generation,
        });
        manager.transition({
          type: "owner-destroyed",
          windowId: owner.windowId,
          webContentsId: owner.webContentsId,
        });
      }
      void manager.serialize(async () => {
        if (bridge.snapshot.composing) await manager.resetComposition();
        publishSnapshot();
      });
      detachLeaseListeners();
    };
    const unsubscribeFocus = subscribeToWindowFocus(({ window: eventWindow, focused }) => {
      if (eventWindow !== window) return;
      if (focused) onFocus();
      else onBlur();
    });
    window.once("closed", onClosed);
    contents.on("render-process-gone", onGone);
    contents.on("did-start-navigation", onNavigation);
    function onNavigation(
      _event: Electron.Event,
      _url: string,
      isInPlace: boolean,
      isMainFrame: boolean,
    ) {
      if (isMainFrame && !isInPlace) releaseOwnedLease("window-navigation");
    }
    leaseListeners = [
      unsubscribeFocus,
      () => window.removeListener("closed", onClosed),
      () => {
        if (!contents.isDestroyed()) contents.removeListener("render-process-gone", onGone);
      },
      () => {
        if (!contents.isDestroyed()) contents.removeListener("did-start-navigation", onNavigation);
      },
    ];
  }

  const performAcquire = (
    event: Electron.IpcMainInvokeEvent,
    request: unknown,
    expectedRevision?: number,
  ) =>
    serialize(async () => {
      if (!isRecord(request)) return rejectLease();
      const owner = ownerFor(event, String(request.targetId ?? ""));
      const window = windowFor(event);
      if (!owner || !window) return rejectLease();
      // Main owns the stealth state; never let a stale renderer lease detach the
      // system IME while the window is meant to stay normally editable.
      if (!isStealthEnabled()) return rejectLease();

      if (isActiveImeLease(manager.lease) && sameOwner(manager.lease.owner, owner)) {
        const state = await currentState();
        if (manager.lease.status === "owned" && !(await ensureKeyboardCapture()))
          return rejectLease();
        logImeDiagnostic("lease-reused", {
          windowId: owner.windowId,
          targetId: owner.targetId,
          generation: manager.lease.generation,
          sessionStatus: manager.lease.status,
          enabled: state.enabled,
        });
        return response(state, manager.lease, true);
      }

      if (manager.lease.status === "disposed" || manager.lease.status === "unavailable")
        return rejectLease();
      const previous = manager.lease;
      await bridge.stopKeyboardCapture();
      detachLeaseListeners();
      if (isActiveImeLease(previous)) {
        logImeDiagnostic("lease-released", {
          windowId: previous.owner.windowId,
          targetId: previous.owner.targetId,
          generation: previous.generation,
          reason: "owner-replaced",
          nextTargetId: owner.targetId,
        });
      }
      if (previous.status === "owned" || previous.status === "suspended") {
        const oldWindow = findWindow(previous.owner.windowId);
        if (oldWindow)
          setImeCandidateState(oldWindow, {
            type: "clear",
            targetId: previous.owner.targetId,
            generation: previous.generation,
          });
      }
      if (isActiveImeLease(previous) && bridge.snapshot.composing) await manager.resetComposition();
      // Stealth may have been turned off while the previous awaits ran. Re-check
      // before detaching so a late acquire cannot undo the restore on the main window.
      if (!isStealthEnabled()) return rejectLease();
      const isolation = isolateNativeIme(window);
      if (isolation === "failed") {
        if (isActiveImeLease(previous))
          logImeDiagnostic("lease-released", {
            windowId: previous.owner.windowId,
            targetId: previous.owner.targetId,
            generation: previous.generation,
            reason: "native-ime-isolation-failed",
          });
        manager.transition({ type: "unavailable" });
        logImeDiagnostic("lease-unavailable", {
          windowId: window.id,
          targetId: owner.targetId,
          reason: "native-ime-isolation-failed",
        });
        return rejectLease();
      }
      manager.transition({ type: "acquire", owner });
      const generation = manager.lease.generation;
      attachLeaseListeners(window, owner, generation);
      const state = await manager.enableEngine();
      if (manager.lease.status !== "owned" || manager.lease.generation !== generation)
        return rejectLease();
      if (!(await ensureKeyboardCapture())) {
        manager.transition({ type: "release", owner, generation });
        detachLeaseListeners();
        return rejectLease();
      }
      logImeDiagnostic("lease-acquired", {
        windowId: owner.windowId,
        webContentsId: owner.webContentsId,
        targetId: owner.targetId,
        generation,
        enabled: state.enabled,
        stealth: isStealthEnabled(),
      });
      return response(state, manager.lease, state.enabled);
    }, expectedRevision);

  const performRelease = (
    event: Electron.IpcMainInvokeEvent,
    request: unknown,
    expectedRevision?: number,
  ) =>
    serialize(async () => {
      if (!isRecord(request) || !Number.isInteger(request.generation)) return rejectLease();
      const current = matchesCurrent(event, request.generation as number, true);
      if (!current) return rejectLease();
      await bridge.stopKeyboardCapture();
      manager.transition({
        type: "release",
        owner: current.owner,
        generation: manager.lease.generation,
      });
      setImeCandidateState(current.window, {
        type: "clear",
        targetId: current.owner.targetId,
        generation: request.generation as number,
      });
      detachLeaseListeners();
      if (bridge.snapshot.composing) await manager.resetComposition();
      const state = await currentState();
      logImeDiagnostic("lease-released", {
        windowId: current.window.id,
        targetId: current.owner.targetId,
        generation: request.generation as number,
        reason: rendererReleaseReason(request.reason),
        composing: bridge.snapshot.composing,
      });
      return {
        state,
        targetId: current.owner.targetId,
        generation: request.generation as number,
        accepted: true,
      };
    }, expectedRevision);

  const performKey = (
    event: Electron.IpcMainInvokeEvent,
    request: unknown,
    expectedRevision?: number,
  ) =>
    serialize(async () => {
      if (!isKeyRequest(request)) return { ...EMPTY_STATE, handled: false };
      const current = matchesCurrent(event, request.generation);
      if (!current) return { ...EMPTY_STATE, handled: false };
      const state = await manager.processKey(request);
      logImeDiagnostic("key-processed", {
        windowId: current.window.id,
        targetId: current.owner.targetId,
        generation: request.generation,
        key: request.key,
        code: request.code,
        ctrl: request.ctrl,
        alt: request.alt,
        meta: request.meta,
        handled: state.handled ?? false,
        composing: state.composing,
        preedit: state.preedit,
        committedText: state.committedText,
        candidates: state.candidates,
        selectedIndex: state.selectedIndex,
        page: state.page,
        hasNextPage: state.hasNextPage,
      });
      return state;
    }, expectedRevision);

  const performSelect = (
    event: Electron.IpcMainInvokeEvent,
    request: unknown,
    expectedRevision?: number,
  ) =>
    serialize(async () => {
      if (
        !isRecord(request) ||
        !Number.isInteger(request.index) ||
        !Number.isInteger(request.generation)
      )
        return { ...EMPTY_STATE, handled: false };
      const current = matchesCurrent(event, request.generation as number);
      if (!current) return { ...EMPTY_STATE, handled: false };
      const state = await manager.selectCandidate(request.index as number);
      logImeDiagnostic("candidate-selected", {
        windowId: current.window.id,
        targetId: current.owner.targetId,
        generation: request.generation,
        index: request.index,
        committedText: state.committedText,
        preedit: state.preedit,
        candidates: state.candidates,
      });
      return state;
    }, expectedRevision);

  const performReset = (
    event: Electron.IpcMainInvokeEvent,
    request: unknown,
    expectedRevision?: number,
  ) =>
    serialize(async () => {
      if (!isRecord(request) || !Number.isInteger(request.generation))
        return { ...EMPTY_STATE, handled: false };
      if (!matchesCurrent(event, request.generation as number))
        return { ...EMPTY_STATE, handled: false };
      return manager.resetComposition();
    }, expectedRevision);

  handle(ImeChannels.SessionCommand, async (event, payload: unknown) => {
    if (!isImeSessionCommand(payload)) return rejectedSessionCommand("", "invalid-transition");
    const cacheKey = `${event.sender.id}:${payload.commandId}`;
    const fingerprint = JSON.stringify(payload);
    const cached = commandResults.get(cacheKey);
    if (cached) {
      return cached.fingerprint === fingerprint
        ? cached.result
        : rejectedSessionCommand(payload.commandId, "command-id-conflict", manager.snapshot);
    }
    const before = manager.snapshot;
    if (payload.expectedRevision !== undefined && payload.expectedRevision !== before.revision)
      return rejectedSessionCommand(payload.commandId, "stale-revision", before);

    let result: unknown;
    try {
      if (payload.type === "acquireTarget") {
        result = await performAcquire(
          event,
          { targetId: payload.targetId },
          payload.expectedRevision,
        );
      } else {
        const current = matchesSessionCommand(event, payload);
        if (!current)
          return rejectedSessionCommand(payload.commandId, "stale-owner", manager.snapshot);
        switch (payload.type) {
          case "releaseTarget":
            result = await performRelease(
              event,
              { generation: payload.generation, reason: payload.reason },
              payload.expectedRevision,
            );
            break;
          case "processKey":
            result = await performKey(event, payload, payload.expectedRevision);
            break;
          case "cancelComposition":
            result = await performReset(
              event,
              { generation: payload.generation },
              payload.expectedRevision,
            );
            break;
          case "selectCandidate":
            result = await performSelect(
              event,
              { generation: payload.generation, index: payload.index },
              payload.expectedRevision,
            );
            break;
          case "suspend":
            result = await manager.serialize(async () => {
              if (
                payload.expectedRevision !== undefined &&
                manager.snapshot.revision !== payload.expectedRevision
              )
                throw new StaleImeRevisionError();
              manager.transition({
                type: "suspend",
                owner: current.owner,
                generation: payload.generation,
              });
              setImeCandidateState(current.window, {
                type: "suspend",
                targetId: current.owner.targetId,
                generation: payload.generation,
              });
              logImeDiagnostic("lease-suspended", {
                windowId: current.window.id,
                targetId: current.owner.targetId,
                generation: payload.generation,
                reason: rendererReleaseReason(payload.reason, "renderer-suspend"),
              });
              return { enabled: manager.engineState.enabled };
            });
            break;
          case "resume":
            result = await manager.serialize(async () => {
              if (
                payload.expectedRevision !== undefined &&
                manager.snapshot.revision !== payload.expectedRevision
              )
                throw new StaleImeRevisionError();
              // Embedded Rime only owns input while stealth is on. A stale resume
              // in normal mode must not re-isolate the system IME.
              if (!isStealthEnabled()) return { invalidTransition: true };
              const previousStatus = manager.lease.status;
              // Re-confirming focus while already owned is a no-op. The owner window
              // keeps its lease across non-activating candidate surfaces, and the
              // renderer re-sends `resume` on every window focus.
              if (manager.lease.status === "owned") {
                manager.transition({
                  type: "confirm-focus",
                  owner: current.owner,
                  generation: payload.generation,
                });
                if (!(await ensureKeyboardCapture())) {
                  manager.transition({
                    type: "suspend",
                    owner: current.owner,
                    generation: payload.generation,
                  });
                  setImeCandidateState(current.window, {
                    type: "suspend",
                    targetId: current.owner.targetId,
                    generation: payload.generation,
                  });
                  return { invalidTransition: true };
                }
                logImeDiagnostic("lease-resumed", {
                  windowId: current.window.id,
                  targetId: current.owner.targetId,
                  generation: payload.generation,
                  previousStatus,
                });
                return { enabled: manager.engineState.enabled };
              }
              if (
                manager.lease.status !== "suspended" ||
                isolateNativeIme(current.window) === "failed"
              )
                return { invalidTransition: true };
              manager.transition({
                type: "confirm-focus",
                owner: current.owner,
                generation: payload.generation,
              });
              if (!(await ensureKeyboardCapture())) {
                manager.transition({
                  type: "suspend",
                  owner: current.owner,
                  generation: payload.generation,
                });
                setImeCandidateState(current.window, {
                  type: "suspend",
                  targetId: current.owner.targetId,
                  generation: payload.generation,
                });
                return { invalidTransition: true };
              }
              logImeDiagnostic("lease-resumed", {
                windowId: current.window.id,
                targetId: current.owner.targetId,
                generation: payload.generation,
                previousStatus,
              });
              return { enabled: manager.engineState.enabled };
            });
            break;
        }
      }
    } catch (error) {
      if (error instanceof StaleImeRevisionError)
        return rejectedSessionCommand(payload.commandId, "stale-revision", manager.snapshot);
      throw error;
    }

    if (isRecord(result) && result.invalidTransition === true)
      return rejectedSessionCommand(payload.commandId, "invalid-transition", manager.snapshot);
    const state = isRecord(result) && isRecord(result.state) ? result.state : result;
    const accepted =
      isRecord(result) && "accepted" in result
        ? result.accepted === true
        : isRecord(state) && state.enabled === true;
    const snapshot = manager.snapshot;
    const commandResult: ImeSessionCommandResult = {
      commandId: payload.commandId,
      accepted,
      ...(payload.type === "processKey" && isRecord(state) && typeof state.handled === "boolean"
        ? { engineHandled: state.handled }
        : {}),
      ...(!accepted ? { reason: "engine-unavailable" as const } : {}),
      snapshot,
      ...(isRecord(state) && typeof state.committedText === "string"
        ? { commit: { text: state.committedText, revision: snapshot.revision } }
        : {}),
    };
    cacheCommandResult(cacheKey, fingerprint, commandResult);
    return commandResult;
  });

  handle(ImeChannels.SessionSnapshot, (event) =>
    serialize(async () => {
      if (!windowFor(event)) return { snapshot: emptySessionSnapshot() };
      return { snapshot: manager.snapshot };
    }),
  );

  function matchesSessionCommand(
    event: Electron.IpcMainInvokeEvent,
    command: Exclude<ImeSessionCommand, { type: "acquireTarget" }>,
  ) {
    const current = matchesCurrent(
      event,
      command.generation,
      command.type === "releaseTarget" || command.type === "resume",
    );
    if (!current || current.owner.targetId !== command.targetId) return undefined;
    return current;
  }

  function cacheCommandResult(
    key: string,
    fingerprint: string,
    result: ImeSessionCommandResult,
  ): void {
    commandResults.set(key, { fingerprint, result });
    if (commandResults.size > 512)
      commandResults.delete(commandResults.keys().next().value as string);
  }

  return {
    available: bridge.available,
    isCurrentLease: (owner: BrowserWindow, targetId: string, generation: number) =>
      manager.lease.status === "owned" &&
      manager.lease.owner.windowId === owner.id &&
      manager.lease.owner.webContentsId === owner.webContents.id &&
      manager.lease.owner.targetId === targetId &&
      manager.lease.generation === generation,
    getSessionSnapshot: () => manager.snapshot,
    dispose: () => {
      ipcMain.removeListener(ImeChannels.Diagnostic, onRendererDiagnostic);
      unsubscribeKeyboardCapture();
      detachLeaseListeners();
      manager.dispose();
    },
  };
  async function currentState(): Promise<ImeState> {
    return manager.engineState;
  }
}

function nativeWindowHandle(window: BrowserWindow | undefined): number {
  if (!window || window.isDestroyed()) return 0;
  const getNativeWindowHandle = window.getNativeWindowHandle;
  if (typeof getNativeWindowHandle !== "function") return 0;
  const handle = getNativeWindowHandle.call(window);
  if (handle.length < 4) return 0;
  return handle.readUInt32LE(0);
}

function response(state: ImeState, current: ImeSessionState, accepted: boolean): ImeLeaseResponse {
  if (!accepted || (current.status !== "owned" && current.status !== "suspended"))
    return { state: { ...EMPTY_STATE }, accepted: false };
  return {
    state,
    targetId: current.owner.targetId,
    generation: current.generation,
    accepted,
  };
}

function rejectLease(): ImeLeaseResponse {
  return { state: { ...EMPTY_STATE }, accepted: false };
}

function emptySessionSnapshot() {
  return {
    phase: "idle" as const,
    engine: {
      enabled: false,
      inputMode: "chinese" as const,
      composing: false,
      preedit: "",
      candidates: [],
      selectedIndex: 0,
      page: 0,
      hasNextPage: false,
    },
    revision: 0,
  };
}

class StaleImeRevisionError extends Error {}

function rejectedSessionCommand(
  commandId: string,
  reason: ImeSessionCommandResult["reason"],
  snapshot: ImeSessionSnapshot = emptySessionSnapshot(),
): ImeSessionCommandResult {
  return { commandId, accepted: false, reason, snapshot };
}

function isImeSessionCommand(value: unknown): value is ImeSessionCommand {
  if (
    !isRecord(value) ||
    typeof value.commandId !== "string" ||
    !/^[a-z0-9._:-]{1,128}$/i.test(value.commandId) ||
    !isTargetId(value.targetId) ||
    (value.expectedRevision !== undefined &&
      (!Number.isInteger(value.expectedRevision) || (value.expectedRevision as number) < 0))
  )
    return false;
  if (value.type === "acquireTarget") return true;
  if (!Number.isInteger(value.generation) || (value.generation as number) < 0) return false;
  switch (value.type) {
    case "releaseTarget":
    case "suspend":
    case "resume":
    case "cancelComposition":
      return true;
    case "processKey":
      return (
        typeof value.key === "string" &&
        typeof value.code === "string" &&
        ["shift", "ctrl", "alt", "meta"].every((key) => typeof value[key] === "boolean") &&
        (value.release === undefined || typeof value.release === "boolean")
      );
    case "selectCandidate":
      return Number.isInteger(value.index) && (value.index as number) >= 0;
    default:
      return false;
  }
}

function findWindow(id: number): BrowserWindow | undefined {
  return [getWindow(), getReplyBarWindow()].find(
    (window) => window && !window.isDestroyed() && window.id === id,
  );
}

function isTargetId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._:-]{0,79}$/i.test(value);
}

const RELEASE_REASON_PATTERN = /^[a-z-]{1,40}$/;

function rendererReleaseReason(value: unknown, fallback = "renderer-unspecified"): string {
  return typeof value === "string" && RELEASE_REASON_PATTERN.test(value) ? value : fallback;
}

function sameOwner(left: ImeOwnerIdentity, right: ImeOwnerIdentity): boolean {
  return (
    left.windowId === right.windowId &&
    left.webContentsId === right.webContentsId &&
    left.targetId === right.targetId
  );
}

function isKeyRequest(value: unknown): value is ImeKeyRequest {
  if (!isRecord(value)) return false;
  return (
    Number.isInteger(value.generation) &&
    ["key", "code"].every((key) => typeof value[key] === "string") &&
    ["shift", "ctrl", "alt", "meta"].every((key) => typeof value[key] === "boolean") &&
    (value.release === undefined || typeof value.release === "boolean")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
