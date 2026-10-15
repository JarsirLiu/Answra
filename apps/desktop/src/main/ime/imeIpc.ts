import {
  ImeChannels,
  type ImeKeyRequest,
  type ImeLeaseResponse,
  type ImeRendererDiagnostic,
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
import { isCurrentProcessForeground } from "../windowForeground";
import { setNativeImeEnabled } from "../windowStealthController";
import { logImeDiagnostic } from "./imeDiagnostics";
import {
  type ImeOwnerIdentity,
  type ImeSessionState,
  initialImeSessionState,
  reduceImeSession,
} from "./imeSessionState";
import { RimeBridge } from "./rimeBridge";

const EMPTY_STATE: ImeState = {
  enabled: false,
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
} {
  const bridge = new RimeBridge();
  let session = { ...initialImeSessionState };
  let blurTimer: ReturnType<typeof setTimeout> | undefined;
  let leaseWindow: BrowserWindow | undefined;
  let leaseListeners: Array<() => void> = [];
  let queue = Promise.resolve();

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation, operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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
      (session.status !== "owned" && !(allowSuspended && session.status === "suspended"))
    )
      return undefined;
    if (
      session.generation !== generation ||
      session.owner.windowId !== window.id ||
      session.owner.webContentsId !== event.sender.id
    )
      return undefined;
    return { window, owner: session.owner };
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
      "focusedRef",
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
    if (
      ["text", "process", "backspace", "enter", "navigation", "other"].includes(
        payload.keyKind ?? "",
      )
    )
      details.keyKind = payload.keyKind as string;
    if (
      payload.event === "key-routing" &&
      (payload.ctrl || payload.alt || payload.meta || payload.keyKind === "backspace")
    ) {
      logImeDiagnostic("key-routing", details);
    } else if (
      payload.event !== "key-routing" &&
      payload.event !== "document-keydown" &&
      payload.event !== "input-mounted"
    ) {
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
    if (session.status !== "owned" || !leaseWindow || leaseWindow.isDestroyed()) return;
    const owner = session.owner;
    const generation = session.generation;
    session = reduceImeSession(session, { type: "suspend", owner, generation });
    setImeCandidateState(leaseWindow, { type: "suspend", targetId: owner.targetId, generation });
    logImeDiagnostic("lease-suspended", { windowId: owner.windowId, generation, reason });
  }

  function attachLeaseListeners(
    window: BrowserWindow,
    owner: ImeOwnerIdentity,
    generation: number,
  ): void {
    detachLeaseListeners();
    leaseWindow = window;
    const onBlur = () => {
      if (blurTimer) clearTimeout(blurTimer);
      blurTimer = setTimeout(() => {
        if (
          leaseWindow !== window ||
          window.isDestroyed() ||
          session.status !== "owned" ||
          session.generation !== generation
        )
          return;
        const focused = BrowserWindow.getFocusedWindow();
        if (isCurrentProcessForeground() && (!focused || focused === window)) return;
        suspendCurrent("owner-window-blur");
      }, BLUR_SETTLE_MS);
    };
    const onFocus = () => {
      if (blurTimer) clearTimeout(blurTimer);
      blurTimer = undefined;
      if (!setNativeImeEnabled(window, false)) {
        suspendCurrent("native-ime-isolation-failed-on-focus");
        logImeDiagnostic("native-ime-isolation-failed-on-focus", {
          windowId: window.id,
          generation,
        });
      }
    };
    const onClosed = () => {
      const currentWindow = findWindow(owner.windowId);
      if (currentWindow)
        setImeCandidateState(currentWindow, {
          type: "clear",
          targetId: owner.targetId,
          generation,
        });
      if (session.status === "owned" || session.status === "suspended") {
        session = reduceImeSession(session, {
          type: "owner-destroyed",
          windowId: owner.windowId,
          webContentsId: owner.webContentsId,
        });
      }
      void serialize(async () => {
        await bridge.reset();
        await bridge.enable(false);
      });
      detachLeaseListeners();
    };
    const onGone = () => onClosed();
    const unsubscribeFocus = subscribeToWindowFocus(({ window: eventWindow, focused }) => {
      if (eventWindow !== window) return;
      if (focused) onFocus();
      else onBlur();
    });
    window.once("closed", onClosed);
    window.webContents.on("render-process-gone", onGone);
    window.webContents.on("did-start-navigation", onNavigation);
    function onNavigation(
      _event: Electron.Event,
      _url: string,
      isInPlace: boolean,
      isMainFrame: boolean,
    ) {
      if (isMainFrame && !isInPlace) onClosed();
    }
    leaseListeners = [
      unsubscribeFocus,
      () => window.removeListener("closed", onClosed),
      () => window.webContents.removeListener("render-process-gone", onGone),
      () => window.webContents.removeListener("did-start-navigation", onNavigation),
    ];
  }

  ipcMain.handle(ImeChannels.Acquire, (event, request: unknown) =>
    serialize(async () => {
      if (!isRecord(request)) return rejectLease();
      const owner = ownerFor(event, String(request.targetId ?? ""));
      const window = windowFor(event);
      if (!owner || !window) return rejectLease();

      if (
        (session.status === "owned" || session.status === "suspended") &&
        sameOwner(session.owner, owner)
      ) {
        const state = await currentState();
        logImeDiagnostic("lease-reused", {
          windowId: owner.windowId,
          targetId: owner.targetId,
          generation: session.generation,
          sessionStatus: session.status,
          enabled: state.enabled,
        });
        return response(state, session, true);
      }

      if (session.status === "disposed" || session.status === "unavailable") return rejectLease();
      const previous = session;
      session = reduceImeSession(session, { type: "acquire", owner });
      const generation = session.generation;
      detachLeaseListeners();
      if (previous.status === "owned" || previous.status === "suspended") {
        const oldWindow = findWindow(previous.owner.windowId);
        if (oldWindow)
          setImeCandidateState(oldWindow, {
            type: "clear",
            targetId: previous.owner.targetId,
            generation: previous.generation,
          });
      }
      await bridge.enable(false);
      await bridge.reset();
      const isolated = setNativeImeEnabled(window, false);
      if (!isolated) {
        session = reduceImeSession(session, { type: "unavailable" });
        return rejectLease();
      }
      attachLeaseListeners(window, owner, generation);
      const state = await bridge.enable(true);
      if (session.status !== "owned" || session.generation !== generation) return rejectLease();
      logImeDiagnostic("lease-acquired", {
        windowId: owner.windowId,
        webContentsId: owner.webContentsId,
        targetId: owner.targetId,
        generation,
        enabled: state.enabled,
        stealth: isStealthEnabled(),
      });
      return response(state, session, state.enabled);
    }),
  );

  ipcMain.handle(ImeChannels.Release, (event, request: unknown) =>
    serialize(async () => {
      if (!isRecord(request) || !Number.isInteger(request.generation)) return rejectLease();
      const current = matchesCurrent(event, request.generation as number, true);
      if (!current) return rejectLease();
      session = reduceImeSession(session, {
        type: "release",
        owner: current.owner,
        generation: session.generation,
      });
      setImeCandidateState(current.window, {
        type: "clear",
        targetId: current.owner.targetId,
        generation: request.generation as number,
      });
      detachLeaseListeners();
      await bridge.reset();
      const state = await bridge.enable(false);
      logImeDiagnostic("lease-released", {
        windowId: current.window.id,
        targetId: current.owner.targetId,
        generation: request.generation as number,
      });
      return response(state, session, true);
    }),
  );

  ipcMain.handle(ImeChannels.ConfirmFocus, (event, request: unknown) =>
    serialize(async () => {
      if (
        !isRecord(request) ||
        !isTargetId(request.targetId) ||
        !Number.isInteger(request.generation)
      )
        return rejectLease();
      const current = matchesCurrent(event, request.generation as number, true);
      if (!current || current.owner.targetId !== request.targetId) return rejectLease();
      session = reduceImeSession(session, {
        type: "confirm-focus",
        owner: current.owner,
        generation: session.generation,
      });
      const state = await currentState();
      logImeDiagnostic("focus-confirmed", {
        windowId: current.window.id,
        targetId: current.owner.targetId,
        generation: session.generation,
        sessionStatus: session.status,
        accepted: session.status === "owned",
        composing: state.composing,
        preeditLength: state.preedit.length,
        candidateCount: state.candidates.length,
      });
      return response(state, session, session.status === "owned");
    }),
  );

  ipcMain.handle(ImeChannels.Key, (event, request: unknown) =>
    serialize(async () => {
      if (!isKeyRequest(request)) return { ...EMPTY_STATE, handled: false };
      const current = matchesCurrent(event, request.generation);
      if (!current) return { ...EMPTY_STATE, handled: false };
      const state = await bridge.key(request);
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
  ipcMain.handle(ImeChannels.Select, (event, request: unknown) =>
    serialize(async () => {
      if (
        !isRecord(request) ||
        !Number.isInteger(request.index) ||
        !Number.isInteger(request.generation)
      )
        return { ...EMPTY_STATE, handled: false };
      const current = matchesCurrent(event, request.generation as number);
      if (!current) return { ...EMPTY_STATE, handled: false };
      const state = await bridge.select(request.index as number);
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
  ipcMain.handle(ImeChannels.Reset, (event, request: unknown) =>
    serialize(async () => {
      if (!isRecord(request) || !Number.isInteger(request.generation))
        return { ...EMPTY_STATE, handled: false };
      if (!matchesCurrent(event, request.generation as number))
        return { ...EMPTY_STATE, handled: false };
      return bridge.reset();
    }),
  );

  return {
    available: bridge.available,
    isCurrentLease: (owner: BrowserWindow, targetId: string, generation: number) =>
      session.status === "owned" &&
      session.owner.windowId === owner.id &&
      session.owner.webContentsId === owner.webContents.id &&
      session.owner.targetId === targetId &&
      session.generation === generation,
    dispose: () => {
      ipcMain.removeListener(ImeChannels.Diagnostic, onRendererDiagnostic);
      detachLeaseListeners();
      session = reduceImeSession(session, { type: "dispose" });
      bridge.dispose();
    },
  };

  async function currentState(): Promise<ImeState> {
    return bridge.enable(true);
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

function findWindow(id: number): BrowserWindow | undefined {
  return [getWindow(), getReplyBarWindow()].find((window) => window?.id === id);
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
  return [
    "acquire-start",
    "acquire-result",
    "confirm-focus-start",
    "confirm-focus-result",
    "input-focus",
    "input-blur",
    "window-focus",
    "window-blur",
    "document-keydown",
    "selection-after-shortcut",
    "key-routing",
    "input-mounted",
  ].includes(String(value.event));
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
    ["shift", "ctrl", "alt", "meta"].every((key) => typeof value[key] === "boolean")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
