import type {
  DesktopBridge,
  ImeCandidateUpdate,
  ImeKeyboardInput,
  ImeSessionCommand,
  ImeSessionCommandResult,
  ImeSessionSnapshot,
  ImeState,
} from "@answra/shared";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  activateImeInputTarget,
  enqueueImeInput,
  getActiveImeInputTargetId,
  isActiveImeInputTarget,
  isCurrentImeInputEvent,
  releaseImeInputTarget,
  subscribeImeInputTargets,
} from "../ime/imeInputTargetCoordinator";
import { type ImeEditorCommand, resolveImeKeyRoute } from "../ime/imeKeyRouter";
import {
  getImeComposing,
  getImeInputMode,
  getImeOwnedGeneration,
  getLatestImeSessionSnapshot,
  publishImeSessionSnapshot,
  selectImeEngineState,
  selectImeOwnedGeneration,
  sendImeSessionCommand,
  subscribeImeSessionSnapshot,
} from "../ime/imeSessionClient";
import {
  resolveImeTextFallback,
  resolveImeTextPolicy,
  shouldPreventImeBeforeInput,
} from "../ime/imeTextPolicy";

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

type ImeSessionCommandInput = ImeSessionCommand extends infer Command
  ? Command extends ImeSessionCommand
    ? Omit<Command, "commandId" | "expectedRevision">
    : never
  : never;

export type ImeNativeKeyHandler = (input: ImeKeyboardInput) => void;

/**
 * Registers one input target with the main-owned session when its editor receives focus.
 *
 * This hook reads every session/focus fact from its single writer instead of mirroring it:
 * the engine snapshot and lease ownership come from `imeSessionClient` (published by main),
 * "which target this renderer currently accepts input for" comes from
 * `imeInputTargetCoordinator`. Local state is limited to user intent (`imeEnabled`).
 */
export function useEmbeddedIme(
  bridge: DesktopBridge | undefined,
  onCommit?: (text: string) => void,
  enabled = true,
  targetId = "conversation-composer",
) {
  const available = Boolean(bridge?.imeAvailable && bridge.imeSessionCommand);
  const [imeEnabled, setImeEnabled] = useState(true);
  const session = useSyncExternalStore(subscribeImeSessionSnapshot, getLatestImeSessionSnapshot);
  const registeredTargetId = useSyncExternalStore(
    subscribeImeInputTargets,
    getActiveImeInputTargetId,
  );
  const onCommitRef = useRef(onCommit);
  const acquirePromiseRef = useRef<Promise<void> | undefined>(undefined);
  const nativeKeyHandlerRef = useRef<ImeNativeKeyHandler | undefined>(undefined);
  onCommitRef.current = onCommit;

  const generation = selectImeOwnedGeneration(session, targetId);
  const ownsLease = generation !== undefined;
  const state = useMemo<ImeState>(
    () =>
      ownsLease && session
        ? session.engine
        : { ...EMPTY_STATE, inputMode: session?.engine.inputMode ?? "chinese" },
    [ownsLease, session],
  );
  const targetRegistered = registeredTargetId === targetId;
  // Native input stays blocked for a target this renderer just registered (acquire in
  // flight) as well as for the lease owner, so Chromium never gets a free shot at the
  // element in between; the lease itself is only what main can revoke.
  const targetEngaged = targetRegistered || (ownsLease && session?.phase === "owned");

  const sendCommand = useCallback(
    async (command: ImeSessionCommandInput): Promise<ImeSessionCommandResult | undefined> =>
      sendImeSessionCommand(bridge, command),
    [bridge],
  );

  useEffect(() => {
    const unsubscribe = bridge?.onImeSessionSnapshot?.((snapshot: ImeSessionSnapshot) => {
      publishImeSessionSnapshot(snapshot);
    });
    void bridge?.getImeSessionSnapshot?.().then((snapshot) => {
      if (snapshot) publishImeSessionSnapshot(snapshot);
    });
    return unsubscribe;
  }, [bridge]);

  const release = useCallback(
    async (reason = "unspecified") => {
      const releasedGeneration = getImeOwnedGeneration(targetId);
      bridge?.imeDiagnostic?.({
        event: "release-called",
        targetId,
        reason,
        generation: releasedGeneration,
        targetRegistered: isActiveImeInputTarget(targetId),
        activeElementTarget: isDomActiveTarget(targetId),
        imeAvailable: available,
        imeEnabled,
      });
      releaseImeInputTarget(targetId);
      if (releasedGeneration !== undefined)
        await sendCommand({
          type: "releaseTarget",
          targetId,
          generation: releasedGeneration,
          reason,
        }).catch(() => undefined);
    },
    [available, bridge, imeEnabled, sendCommand, targetId],
  );

  const blur = useCallback(() => {
    bridge?.imeDiagnostic?.({
      event: "input-blur",
      targetId,
      generation: getImeOwnedGeneration(targetId),
      targetRegistered: isActiveImeInputTarget(targetId),
      activeElementTarget: isDomActiveTarget(targetId),
      documentHasFocus: document.hasFocus(),
      imeAvailable: available,
      imeEnabled,
    });
    // Registration is the renderer's own fact: dropping it stops every queued and future
    // key for this target, while the lease stays with main until focus returns or it closes.
    releaseImeInputTarget(targetId);
  }, [available, bridge, imeEnabled, targetId]);

  const confirmFocus = useCallback(async () => {
    const currentGeneration = getImeOwnedGeneration(targetId);
    if (currentGeneration === undefined || !isDomActiveTarget(targetId)) return;
    const result = await sendCommand({ type: "resume", targetId, generation: currentGeneration });
    if (
      !isActiveImeInputTarget(targetId) ||
      !result?.accepted ||
      result.snapshot.owner?.generation !== currentGeneration
    )
      releaseImeInputTarget(targetId);
  }, [sendCommand, targetId]);

  const acquire = useCallback(async () => {
    const focusDetails = () => ({
      targetId,
      generation: getImeOwnedGeneration(targetId),
      activeElementTarget: isDomActiveTarget(targetId),
      documentHasFocus: document.hasFocus(),
      targetRegistered: isActiveImeInputTarget(targetId),
      imeAvailable: available,
      imeEnabled,
    });
    bridge?.imeDiagnostic?.({ event: "input-focus", ...focusDetails() });
    bridge?.imeDiagnostic?.({ event: "acquire-start", ...focusDetails() });
    if (!available || !enabled || !imeEnabled || !bridge?.imeSessionCommand) {
      bridge?.imeDiagnostic?.({ event: "acquire-result", ...focusDetails(), accepted: false });
      return;
    }
    activateImeInputTarget(targetId, () => void release("target-switched"));
    if (getImeOwnedGeneration(targetId) !== undefined) return confirmFocus();
    if (acquirePromiseRef.current) return acquirePromiseRef.current;
    const pendingAcquire = (async () => {
      const result = await sendCommand({ type: "acquireTarget", targetId });
      if (!result) {
        bridge.imeDiagnostic?.({ event: "acquire-result", ...focusDetails(), accepted: false });
        return;
      }
      const acquiredGeneration = result.snapshot.owner?.generation;
      const acquiredByTarget = result.snapshot.owner?.targetId === targetId;
      if (!isActiveImeInputTarget(targetId)) {
        if (acquiredGeneration !== undefined && acquiredByTarget)
          await sendCommand({
            type: "releaseTarget",
            targetId,
            generation: acquiredGeneration,
            reason: "focus-lost-during-acquire",
          });
        bridge.imeDiagnostic?.({
          event: "acquire-result",
          ...focusDetails(),
          generation: acquiredGeneration,
          accepted: false,
        });
        return;
      }
      if (!result.accepted || !acquiredByTarget || acquiredGeneration === undefined) {
        releaseImeInputTarget(targetId);
        if (acquiredGeneration !== undefined)
          await sendCommand({
            type: "releaseTarget",
            targetId,
            generation: acquiredGeneration,
            reason: "acquire-rejected",
          });
        bridge.imeDiagnostic?.({
          event: "acquire-result",
          ...focusDetails(),
          generation: acquiredGeneration,
          accepted: false,
        });
        return;
      }
      bridge.imeDiagnostic?.({
        event: "acquire-result",
        ...focusDetails(),
        generation: acquiredGeneration,
        accepted: true,
      });
    })();
    acquirePromiseRef.current = pendingAcquire;
    try {
      await pendingAcquire;
    } finally {
      if (acquirePromiseRef.current === pendingAcquire) acquirePromiseRef.current = undefined;
    }
  }, [available, bridge, confirmFocus, enabled, imeEnabled, release, sendCommand, targetId]);

  useEffect(() => {
    if (!enabled || !imeEnabled || !available) void release("effect-inactive");
  }, [available, enabled, imeEnabled, release]);

  // A registration must not outlive the lease it was opened for: if main reports the
  // session as idle or owned elsewhere while this renderer still routes input here,
  // drop the registration so keys fall back to the editor instead of being swallowed.
  useEffect(() => {
    if (!targetRegistered || ownsLease) return;
    if (acquirePromiseRef.current) return;
    releaseImeInputTarget(targetId);
  }, [ownsLease, targetId, targetRegistered]);

  useEffect(() => {
    bridge?.imeDiagnostic?.({
      event: "input-mounted",
      targetId,
      activeElementTarget: isDomActiveTarget(targetId),
      documentHasFocus: document.hasFocus(),
      targetRegistered: isActiveImeInputTarget(targetId),
      imeAvailable: available,
      imeEnabled,
    });
  }, [available, bridge, imeEnabled, targetId]);

  useEffect(() => {
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      const eventTarget = event.target;
      if (
        eventTarget instanceof Element &&
        eventTarget.closest(`[data-ime-target-id="${targetId}"]`)
      )
        return;
      bridge?.imeDiagnostic?.({
        event: "document-keydown",
        targetId,
        generation: getImeOwnedGeneration(targetId),
        targetRegistered: isActiveImeInputTarget(targetId),
        activeElementTarget: isDomActiveTarget(targetId),
        documentHasFocus: document.hasFocus(),
        imeAvailable: available,
        imeEnabled,
        keyCode: event.code,
        keyKind: getKeyKind(event.key),
        repeat: event.repeat,
        ctrl: event.ctrlKey,
        alt: event.altKey,
        meta: event.metaKey,
      });
    };
    document.addEventListener("keydown", onDocumentKeyDown, true);
    const onDocumentKeyUp = (event: KeyboardEvent) => {
      const isSelectAll = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a";
      const isDelete = event.key === "Backspace" || event.key === "Delete";
      if (
        (!isSelectAll && !isDelete) ||
        !(event.target instanceof Element) ||
        !event.target.closest(`[data-ime-target-id="${targetId}"]`)
      )
        return;
      bridge?.imeDiagnostic?.({
        event: "selection-after-shortcut",
        targetId,
        generation: getImeOwnedGeneration(targetId),
        key: event.key,
        keyCode: event.code,
        ctrl: event.ctrlKey,
        alt: event.altKey,
        meta: event.metaKey,
        composing: getImeComposing(),
        documentHasFocus: document.hasFocus(),
        ...getSelectionSummary(event.target),
      });
    };
    document.addEventListener("keyup", onDocumentKeyUp, true);
    return () => {
      document.removeEventListener("keydown", onDocumentKeyDown, true);
      document.removeEventListener("keyup", onDocumentKeyUp, true);
    };
  }, [available, bridge, imeEnabled, targetId]);

  useEffect(() => {
    const onWindowFocus = () => {
      const activeElementTarget = isDomActiveTarget(targetId);
      bridge?.imeDiagnostic?.({
        event: "window-focus",
        targetId,
        generation: getImeOwnedGeneration(targetId),
        activeElementTarget,
        documentHasFocus: document.hasFocus(),
        targetRegistered: isActiveImeInputTarget(targetId),
        imeAvailable: available,
        imeEnabled,
      });
      if (activeElementTarget) void confirmFocus();
    };
    const onWindowBlur = () => {
      bridge?.imeDiagnostic?.({
        event: "window-blur",
        targetId,
        generation: getImeOwnedGeneration(targetId),
        activeElementTarget: isDomActiveTarget(targetId),
        documentHasFocus: document.hasFocus(),
        targetRegistered: isActiveImeInputTarget(targetId),
        imeAvailable: available,
        imeEnabled,
      });
    };
    window.addEventListener("focus", onWindowFocus);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("focus", onWindowFocus);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [available, bridge, confirmFocus, imeEnabled, targetId]);

  // Release only on real unmount: keying this cleanup on `release` identity would
  // fire on every re-render when `bridge` (window.answra) hands back a new object,
  // dropping the lease mid-composition after the first keystroke.
  const releaseRef = useRef(release);
  releaseRef.current = release;
  useEffect(
    () => () => {
      void releaseRef.current("unmount");
    },
    [],
  );

  const enqueueInput = useCallback(
    (
      request: (
        generation: number,
        snapshot: ImeSessionSnapshot | undefined,
      ) => Promise<ImeSessionCommandResult | undefined>,
      applyFallback?: (result: ImeSessionCommandResult) => void,
      routeLatest?: (
        snapshot: ImeSessionSnapshot | undefined,
      ) => ImeEditorCommand | "ignored" | undefined,
      applyEditorCommand?: (command: ImeEditorCommand) => void,
    ) => {
      if (!isActiveImeInputTarget(targetId)) return;
      void enqueueImeInput(targetId, async (_queuedSnapshot, inputContext) => {
        if (getImeOwnedGeneration(targetId) === undefined) await acquirePromiseRef.current;
        const generation = getImeOwnedGeneration(targetId);
        if (generation === undefined || !isActiveImeInputTarget(targetId)) return;
        const currentSnapshot = getLatestImeSessionSnapshot();
        const editorCommand = routeLatest?.(currentSnapshot);
        if (editorCommand === "ignored") return;
        if (editorCommand) {
          applyEditorCommand?.(editorCommand);
          return;
        }
        const result = await request(generation, currentSnapshot);
        if (
          !result?.accepted ||
          getImeOwnedGeneration(targetId) !== generation ||
          !isCurrentImeInputEvent(targetId, inputContext.targetEpoch)
        )
          return;
        if (result.commit) onCommitRef.current?.(result.commit.text);
        else if (result.engineHandled === false) {
          applyFallback?.(result);
          const fallback = routeLatest?.(result.snapshot);
          if (fallback && fallback !== "ignored") applyEditorCommand?.(fallback);
        }
      }).catch((error: unknown) => console.error("[ime-ui] key processing failed", error));
    },
    [targetId],
  );

  const sendKey = useCallback(
    (
      event: KeyboardEvent | React.KeyboardEvent<HTMLElement>,
      release = false,
      applyEditorCommand?: (command: ImeEditorCommand) => void,
    ) => {
      const keyKind = getKeyKind(event.key);
      const reportRouting = (accepted: boolean) => {
        const modifierKey = ["Control", "Shift", "Alt", "Meta"].includes(event.key);
        const selection = getSelectionSummary(event.target);
        const hasModifier = event.ctrlKey || event.altKey || event.metaKey;
        const isEditingKey =
          (event.key === "Backspace" || event.key === "Delete") &&
          (!getImeComposing() || (selection.selectionLength ?? 0) > 0);
        if (modifierKey || (!hasModifier && !isEditingKey)) return;
        bridge?.imeDiagnostic?.({
          event: "key-routing",
          targetId,
          generation: getImeOwnedGeneration(targetId),
          activeElementTarget: isDomActiveTarget(targetId),
          documentHasFocus: document.hasFocus(),
          targetRegistered: isActiveImeInputTarget(targetId),
          imeAvailable: available,
          imeEnabled,
          composing: getImeComposing(),
          accepted,
          key: event.key,
          keyCode: event.code,
          keyKind,
          repeat: event.repeat,
          ctrl: event.ctrlKey,
          alt: event.altKey,
          meta: event.metaKey,
          ...selection,
        });
      };
      if (
        !available ||
        !enabled ||
        !imeEnabled ||
        !bridge?.imeSessionCommand ||
        !isActiveImeInputTarget(targetId)
      ) {
        reportRouting(false);
        return false;
      }
      const verticalNavigationKey = ["ArrowUp", "ArrowDown", "PageUp", "PageDown"].includes(
        event.key,
      );
      const queuedEditorKey =
        !release &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        [
          "Backspace",
          "Delete",
          "ArrowLeft",
          "ArrowRight",
          "ArrowUp",
          "ArrowDown",
          "PageUp",
          "PageDown",
        ].includes(event.key) &&
        // 非组词的纵向移动由 imeKeyRouter 路由成 browser（折行渲染只有原生懂），
        // 必须走下方直连路由返回 handled=false；queuedEditorKey 路径无条件返回
        // handled=true，会 preventDefault 吞掉方向键，折行后光标下不去。
        !(verticalNavigationKey && !getImeComposing());
      if (queuedEditorKey) {
        const routingEvent = Object.freeze({
          key: event.key,
          code: event.code,
          shiftKey: event.shiftKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          metaKey: event.metaKey,
          repeat: event.repeat,
        });
        const keyEvent = {
          key: routingEvent.key,
          code: routingEvent.code,
          shift: routingEvent.shiftKey,
          ctrl: routingEvent.ctrlKey,
          alt: routingEvent.altKey,
          meta: routingEvent.metaKey,
          release: false,
        };
        enqueueInput(
          (generation) =>
            sendCommand({
              type: "processKey",
              targetId,
              generation,
              ...keyEvent,
            }),
          undefined,
          (latest) => {
            if (!latest) return "ignored";
            const route = resolveImeKeyRoute(routingEvent, selectImeEngineState(latest));
            return route.type === "editor"
              ? route.command
              : route.type === "engine"
                ? undefined
                : "ignored";
          },
          applyEditorCommand,
        );
        reportRouting(true);
        return true;
      }
      const route = resolveImeKeyRoute(
        event,
        selectImeEngineState(getLatestImeSessionSnapshot()),
        release,
      );
      if (route.type === "consumed") {
        reportRouting(true);
        return true;
      }
      if (route.type === "browser") {
        reportRouting(false);
        return false;
      }
      if (route.type !== "engine") {
        reportRouting(false);
        return false;
      }
      const keyEvent = {
        key: route.key,
        code: event.code,
        shift: event.shiftKey,
        ctrl: event.ctrlKey,
        alt: event.altKey,
        meta: event.metaKey,
        release: route.release,
        text: event.key.length === 1 ? event.key : undefined,
      };
      enqueueInput(
        (generation) =>
          sendCommand({
            type: "processKey",
            targetId,
            generation,
            key: keyEvent.key,
            code: keyEvent.code,
            shift: keyEvent.shift,
            ctrl: keyEvent.ctrl,
            alt: keyEvent.alt,
            meta: keyEvent.meta,
            release: keyEvent.release,
          }),
        (result) => {
          const text = resolveImeTextFallback({
            engine: result.snapshot.engine,
            key: keyEvent.key,
            text: keyEvent.text,
            shift: keyEvent.shift,
            ctrl: keyEvent.ctrl,
            alt: keyEvent.alt,
            meta: keyEvent.meta,
          });
          if (text !== undefined) onCommitRef.current?.(text);
        },
      );
      reportRouting(true);
      return true;
    },
    [available, bridge, enabled, enqueueInput, imeEnabled, sendCommand, targetId],
  );

  const sendNativeKey = useCallback(
    (
      input: ImeKeyboardInput,
      applyEditorCommand?: (command: ImeEditorCommand) => void,
      captureCompositionStart?: () => void,
    ) => {
      if (
        input.type === "keydown" &&
        (input.key.length === 1 || input.key === "Process") &&
        !input.ctrl &&
        !input.alt &&
        !input.meta
      )
        captureCompositionStart?.();
      const event = {
        key: input.key,
        code: input.code,
        shiftKey: input.shift,
        ctrlKey: input.ctrl,
        altKey: input.alt,
        metaKey: input.meta,
        repeat: input.repeat,
        target: null,
      } as unknown as KeyboardEvent;
      return sendKey(event, input.type === "keyup", applyEditorCommand);
    },
    [sendKey],
  );

  const setNativeKeyHandler = useCallback((handler: ImeNativeKeyHandler | undefined) => {
    nativeKeyHandlerRef.current = handler;
  }, []);

  useEffect(() => {
    const unsubscribe = bridge?.onImeKeyboardInput?.((input: ImeKeyboardInput) => {
      if (
        input.targetId !== targetId ||
        input.generation !== getImeOwnedGeneration(targetId) ||
        !isActiveImeInputTarget(targetId)
      )
        return;
      nativeKeyHandlerRef.current?.(input);
    });
    return unsubscribe;
  }, [bridge, targetId]);

  const sendKeyUp = useCallback(
    (event: KeyboardEvent | React.KeyboardEvent<HTMLElement>) => sendKey(event, true),
    [sendKey],
  );

  const sendNavigation = useCallback(
    (key: string) => {
      if (!bridge?.imeSessionCommand) return;
      enqueueInput((generation) =>
        sendCommand({
          type: "processKey",
          targetId,
          generation,
          key,
          code: key,
          shift: false,
          ctrl: false,
          alt: false,
          meta: false,
        }),
      );
    },
    [bridge, enqueueInput, sendCommand, targetId],
  );

  const select = useCallback(
    (index: number) => {
      if (!bridge?.imeSessionCommand) return;
      enqueueInput((generation) =>
        sendCommand({ type: "selectCandidate", targetId, generation, index }),
      );
    },
    [bridge, enqueueInput, sendCommand, targetId],
  );

  const cancelComposition = useCallback(() => {
    if (!bridge?.imeSessionCommand) return;
    enqueueInput((generation) => sendCommand({ type: "cancelComposition", targetId, generation }));
  }, [bridge, enqueueInput, sendCommand, targetId]);

  useEffect(() => {
    if (!available || !enabled) return;
    return bridge?.onImeCandidateAction?.((action) => {
      if (
        action.generation !== getImeOwnedGeneration(targetId) ||
        action.targetId !== targetId ||
        !isActiveImeInputTarget(targetId)
      )
        return;
      if (action.type === "select") select(action.index);
      else sendNavigation(action.key);
    });
  }, [available, bridge, enabled, select, sendNavigation, targetId]);

  const updateCandidate = useCallback(
    (payload: ImeCandidateUpdate) => {
      const generation = getImeOwnedGeneration(targetId);
      const snapshot = getLatestImeSessionSnapshot();
      bridge?.imeDiagnostic?.({
        event: "candidate-update",
        targetId,
        ...(generation !== undefined ? { generation } : {}),
        reason:
          payload.type === "show" && generation === undefined
            ? "show-without-generation"
            : payload.type,
        composing: snapshot?.engine.composing,
        engineEnabled: snapshot?.engine.enabled,
        preedit: snapshot?.engine.preedit,
        candidates: snapshot?.engine.candidates,
      });
      if (generation !== undefined) bridge?.setImeCandidate?.({ ...payload, targetId, generation });
    },
    [bridge, targetId],
  );

  const toggle = useCallback(() => setImeEnabled((current) => !current), []);
  const textPolicy = resolveImeTextPolicy({
    targetOwned: targetEngaged,
    composing: state.composing,
  });

  return {
    available: enabled && available,
    imeEnabled,
    asciiMode: getImeInputMode() === "ascii",
    targetEngaged,
    textPolicy,
    shouldPreventBeforeInput: (inputType: string) =>
      shouldPreventImeBeforeInput(textPolicy, inputType),
    active: enabled && imeEnabled && available && state.enabled,
    state,
    generation,
    targetId,
    acquire,
    release,
    blur,
    sendKey,
    sendKeyUp,
    sendNativeKey,
    setNativeKeyHandler,
    sendNavigation,
    select,
    cancelComposition,
    updateCandidate,
    toggle,
  };
}

function isDomActiveTarget(targetId: string): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement && active.dataset.imeTargetId === targetId;
}

function getKeyKind(
  key: string,
): "text" | "process" | "backspace" | "enter" | "navigation" | "other" {
  if (key === "Process") return "process";
  if (key === "Backspace") return "backspace";
  if (key === "Enter") return "enter";
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown"].includes(key))
    return "navigation";
  return key.length === 1 ? "text" : "other";
}

function getSelectionSummary(target: EventTarget | null): {
  selectionStart?: number;
  selectionEnd?: number;
  selectionLength?: number;
  valueLength?: number;
} {
  if (!(target instanceof HTMLElement)) return {};
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const start = target.selectionStart;
    const end = target.selectionEnd;
    return {
      ...(start === null ? {} : { selectionStart: start }),
      ...(end === null ? {} : { selectionEnd: end }),
      ...(start === null || end === null ? {} : { selectionLength: Math.max(0, end - start) }),
      valueLength: target.value.length,
    };
  }
  const selection = document.getSelection();
  if (!selection || !target.contains(selection.anchorNode)) return {};
  return {
    selectionLength: selection.toString().length,
    valueLength: target.textContent?.length ?? 0,
  };
}
