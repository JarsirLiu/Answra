import {
  IME_RENDERER_DIAGNOSTIC_EVENTS,
  ImeChannels,
  type ImeKeyRequest,
  type ImeLeaseResponse,
  type ImeRendererDiagnostic,
  type ImeRendererDiagnosticEvent,
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
const DIAGNOSTIC_TARGET_IDS = new Set([
  "chat-composer",
  "reply-composer",
  "settings-base-url",
  "settings-model",
  "workspace-directory-filter",
  "workspace-markdown-editor",
  "main-composer",
]);

export function registerImeIpc(): {
  dispose: () => void;
  available: boolean;
  isCurrentLease: (owner: BrowserWindow, targetId: string, generation: number) => boolean;
  getSessionSnapshot: () => ImeSessionSnapshot;
} {
  const bridge = new RimeBridge();
  const manager = new ImeSessionManager(bridge);
  let blurTimer: ReturnType<typeof setTimeout> | undefined;
  let leaseWindow: BrowserWindow | undefined;
  let leaseListeners: Array<() => void> = [];
  let lastPublishedRevision = -1;
  const commandResults = new Map<
    string,
    { fingerprint: string; result: ImeSessionCommandResult }
  >();
  const expectedRevisionByEvent = new WeakMap<Electron.IpcMainInvokeEvent, number>();
  const invokeHandlers = new Map<
    string,
    (event: Electron.IpcMainInvokeEvent, payload: unknown) => unknown
  >();
  const serialize = <T>(event: Electron.IpcMainInvokeEvent, operation: () => Promise<T>) =>
    manager.serialize(async () => {
      const expectedRevision = expectedRevisionByEvent.get(event);
      if (expectedRevision !== undefined) {
        expectedRevisionByEvent.delete(event);
        if (manager.snapshot.revision !== expectedRevision) throw new StaleImeRevisionError();
      }
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
    invokeHandlers.set(channel, listener);
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

  const onRendererDiagnostic = (event: Electron.IpcMainEvent, payload: unknown): void => {
    if (isImeCandidateWindowFromSender(event)) {
      const candidateWindow = BrowserWindow.fromWebContents(event.sender);
      if (!candidateWindow || !isCandidateRendererDiagnostic(payload)) return;
      if (payload.event === "candidate-rendered")
        logImeDiagnostic(payload.event, {
          windowId: candidateWindow.id,
          webContentsId: event.sender.id,
          targetId: payload.targetId,
          ownerTargetId: payload.ownerTargetId,
          generation: payload.generation,
          preedit: payload.preedit,
          candidates: payload.candidates,
          selectedIndex: payload.selectedIndex,
          page: payload.page,
          documentVisibility: payload.documentVisibility,
          documentHasFocus: payload.documentHasFocus,
          candidateRoot: payload.candidateRoot,
          candidatePopup: payload.candidatePopup,
        });
      return;
    }
    const window = windowFor(event);
    if (!window || !isImeRendererDiagnostic(payload)) return;
    const details: Record<string, unknown> = {
      windowId: window.id,
      webContentsId: event.sender.id,
      targetId: payload.targetId,
    };
    if (payload.source === "input-focus" || payload.source === "window-focus")
      details.source = payload.source;
    if (Number.isInteger(payload.generation)) details.generation = payload.generation as number;
    if (typeof payload.key === "string") details.key = payload.key;
    if (typeof payload.preedit === "string") details.preedit = payload.preedit;
    if (typeof payload.committedText === "string") details.committedText = payload.committedText;
    if (Array.isArray(payload.candidates)) details.candidates = payload.candidates;
    for (const key of [
      "selectionStart",
      "selectionEnd",
      "selectionLength",
      "valueLength",
    ] as const) {
      const value = payload[key];
      if (Number.isInteger(value)) details[key] = value;
    }
    for (const key of [
      "activeElementTarget",
      "documentHasFocus",
      "targetRegistered",
      "imeAvailable",
      "imeEnabled",
      "composing",
      "accepted",
      "repeat",
      "ctrl",
      "alt",
      "meta",
    ] as const) {
      const value = payload[key];
      if (typeof value === "boolean") details[key] = value;
    }
    if (typeof payload.keyCode === "string" && /^[a-z0-9]{1,24}$/i.test(payload.keyCode))
      details.keyCode = payload.keyCode;
    if (typeof payload.reason === "string" && /^[a-z-]{1,40}$/.test(payload.reason))
      details.reason = payload.reason;
    if (
      ["text", "process", "backspace", "enter", "navigation", "other"].includes(
        payload.keyKind ?? "",
      )
    )
      details.keyKind = payload.keyKind as string;
    if (payload.event === "document-keydown" || payload.event === "input-mounted") {
      if (isImeDebugEnabled()) logImeDiagnostic(`renderer-${payload.event}`, details);
    } else if (
      payload.event === "key-routing" &&
      !isImeDebugEnabled() &&
      !(payload.ctrl || payload.alt || payload.meta || payload.keyKind === "backspace")
    ) {
      return;
    } else if (payload.event === "key-routing") {
      logImeDiagnostic("key-routing", details);
    } else {
      logImeDiagnostic(`renderer-${payload.event}`, details);
    }
  };
  ipcMain.on(ImeChannels.Diagnostic, onRendererDiagnostic);

  function detachLeaseListeners(): void {
    for (const detach of leaseListeners) detach();
    leaseListeners = [];
    leaseWindow = undefined;
    if (blurTimer) clearTimeout(blurTimer);
    blurTimer = undefined;
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

  handle(ImeChannels.Acquire, (event, request: unknown) =>
    serialize(event, async () => {
      if (!isRecord(request)) return rejectLease();
      const owner = ownerFor(event, String(request.targetId ?? ""));
      const window = windowFor(event);
      if (!owner || !window) return rejectLease();

      if (isActiveImeLease(manager.lease) && sameOwner(manager.lease.owner, owner)) {
        const state = await currentState();
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
      logImeDiagnostic("lease-acquired", {
        windowId: owner.windowId,
        webContentsId: owner.webContentsId,
        targetId: owner.targetId,
        generation,
        enabled: state.enabled,
        stealth: isStealthEnabled(),
      });
      return response(state, manager.lease, state.enabled);
    }),
  );

  handle(ImeChannels.Release, (event, request: unknown) =>
    serialize(event, async () => {
      if (!isRecord(request) || !Number.isInteger(request.generation)) return rejectLease();
      const current = matchesCurrent(event, request.generation as number, true);
      if (!current) return rejectLease();
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
    }),
  );

  handle(ImeChannels.ConfirmFocus, (event, request: unknown) =>
    serialize(event, async () => {
      if (
        !isRecord(request) ||
        !isTargetId(request.targetId) ||
        !Number.isInteger(request.generation)
      )
        return rejectLease();
      const current = matchesCurrent(event, request.generation as number, true);
      if (!current || current.owner.targetId !== request.targetId) return rejectLease();
      manager.transition({
        type: "confirm-focus",
        owner: current.owner,
        generation: manager.lease.generation,
      });
      const state = await currentState();
      logImeDiagnostic("focus-confirmed", {
        windowId: current.window.id,
        targetId: current.owner.targetId,
        generation: manager.lease.generation,
        sessionStatus: manager.lease.status,
        accepted: manager.lease.status === "owned",
        composing: state.composing,
        preeditLength: state.preedit.length,
        candidateCount: state.candidates.length,
      });
      return response(state, manager.lease, manager.lease.status === "owned");
    }),
  );

  handle(ImeChannels.Key, (event, request: unknown) =>
    serialize(event, async () => {
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
    }),
  );
  handle(ImeChannels.Select, (event, request: unknown) =>
    serialize(event, async () => {
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
    }),
  );
  handle(ImeChannels.Reset, (event, request: unknown) =>
    serialize(event, async () => {
      if (!isRecord(request) || !Number.isInteger(request.generation))
        return { ...EMPTY_STATE, handled: false };
      if (!matchesCurrent(event, request.generation as number))
        return { ...EMPTY_STATE, handled: false };
      return manager.resetComposition();
    }),
  );
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
    if (payload.type === "acquireTarget") {
      result = await invokeLegacyHandler(
        ImeChannels.Acquire,
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
          result = await invokeLegacyHandler(
            ImeChannels.Release,
            event,
            { generation: payload.generation, reason: payload.reason },
            payload.expectedRevision,
          );
          break;
        case "processKey":
          result = await invokeLegacyHandler(
            ImeChannels.Key,
            event,
            payload,
            payload.expectedRevision,
          );
          break;
        case "cancelComposition":
          result = await invokeLegacyHandler(
            ImeChannels.Reset,
            event,
            { generation: payload.generation },
            payload.expectedRevision,
          );
          break;
        case "selectCandidate":
          result = await invokeLegacyHandler(
            ImeChannels.Select,
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
              return { staleRevision: true };
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
              return { staleRevision: true };
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

    if (isRecord(result) && result.staleRevision === true)
      return rejectedSessionCommand(payload.commandId, "stale-revision", manager.snapshot);
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
    serialize(event, async () => {
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

  async function invokeLegacyHandler(
    channel: string,
    event: Electron.IpcMainInvokeEvent,
    payload: unknown,
    expectedRevision?: number,
  ): Promise<unknown> {
    const handler = invokeHandlers.get(channel);
    if (!handler) return undefined;
    if (expectedRevision !== undefined) expectedRevisionByEvent.set(event, expectedRevision);
    try {
      return await handler(event, payload);
    } catch (error) {
      if (error instanceof StaleImeRevisionError) return { staleRevision: true };
      throw error;
    }
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
      detachLeaseListeners();
      manager.dispose();
    },
  };
  async function currentState(): Promise<ImeState> {
    return manager.engineState;
  }
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

function isImeRendererDiagnostic(value: unknown): value is ImeRendererDiagnostic {
  if (
    !isRecord(value) ||
    typeof value.targetId !== "string" ||
    !DIAGNOSTIC_TARGET_IDS.has(value.targetId)
  )
    return false;
  // `candidate-rendered` is validated by `isCandidateRendererDiagnostic`; every
  // other event name must exist in the shared runtime list so the renderer and
  // this whitelist cannot drift apart silently.
  return (
    value.event !== "candidate-rendered" &&
    IME_RENDERER_DIAGNOSTIC_EVENTS.includes(value.event as ImeRendererDiagnosticEvent)
  );
}

const RELEASE_REASON_PATTERN = /^[a-z-]{1,40}$/;

function rendererReleaseReason(value: unknown, fallback = "renderer-unspecified"): string {
  return typeof value === "string" && RELEASE_REASON_PATTERN.test(value) ? value : fallback;
}

function isCandidateRendererDiagnostic(value: unknown): value is ImeRendererDiagnostic {
  if (!isRecord(value) || value.targetId !== "ime-candidate-window") return false;
  if (!Number.isInteger(value.generation) || typeof value.ownerTargetId !== "string") return false;
  if (value.event !== "candidate-rendered") return false;
  if (value.preedit !== undefined && typeof value.preedit !== "string") return false;
  if (
    value.candidates !== undefined &&
    (!Array.isArray(value.candidates) ||
      !value.candidates.every(
        (candidate) =>
          isRecord(candidate) &&
          typeof candidate.text === "string" &&
          (candidate.comment === undefined || typeof candidate.comment === "string"),
      ))
  )
    return false;
  return true;
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
