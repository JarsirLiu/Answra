import type {
  DesktopBridge,
  ImeCandidateUpdate,
  ImeSessionCommand,
  ImeSessionCommandResult,
  ImeSessionSnapshot,
  ImeState,
} from "@answra/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  activateImeInputTarget,
  enqueueImeInput,
  getLatestImeSessionSnapshot,
  isActiveImeInputTarget,
  publishImeSessionSnapshot,
  releaseImeInputTarget,
} from "../ime/imeInputTargetCoordinator";
import { type ImeEditorCommand, resolveImeKeyRoute } from "../ime/imeKeyRouter";
import { resolveImeTextPolicy, shouldPreventImeBeforeInput } from "../ime/imeTextPolicy";

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

/** Registers one input target with the main-owned session when its editor receives focus. */
export function useEmbeddedIme(
  bridge: DesktopBridge | undefined,
  onCommit?: (text: string) => void,
  enabled = true,
  targetId = "conversation-composer",
) {
  const available = Boolean(bridge?.imeAvailable && bridge.imeSessionCommand);
  const [imeEnabled, setImeEnabled] = useState(true);
  const [state, setState] = useState<ImeState>(EMPTY_STATE);
  const [asciiMode, setAsciiMode] = useState(false);
  const asciiModeRef = useRef(false);
  const [targetEngaged, setTargetEngaged] = useState(false);
  const [generation, setGeneration] = useState<number | undefined>(undefined);
  const generationRef = useRef<number | undefined>(undefined);
  const revisionRef = useRef(0);
  const focusedRef = useRef(false);
  const onCommitRef = useRef(onCommit);
  const acquirePromiseRef = useRef<Promise<void> | undefined>(undefined);
  onCommitRef.current = onCommit;

  const applySnapshot = useCallback(
    (snapshot: ImeSessionSnapshot) => {
      if (snapshot.revision < revisionRef.current) return;
      publishImeSessionSnapshot(snapshot);
      const previousRevision = revisionRef.current;
      revisionRef.current = snapshot.revision;
      const isAscii = snapshot.engine.inputMode === "ascii";
      asciiModeRef.current = isAscii;
      setAsciiMode(isAscii);
      const generation = generationRef.current;
      if (
        generation !== undefined &&
        snapshot.owner?.generation === generation &&
        snapshot.owner.targetId === targetId
      ) {
        setState(snapshot.engine);
        setTargetEngaged(snapshot.phase === "owned");
      } else if (generation !== undefined && snapshot.revision > previousRevision) {
        generationRef.current = undefined;
        setGeneration(undefined);
        setState({ ...EMPTY_STATE, inputMode: snapshot.engine.inputMode });
        setTargetEngaged(false);
      }
    },
    [targetId],
  );

  const sendCommand = useCallback(
    async (command: ImeSessionCommandInput): Promise<ImeSessionCommandResult | undefined> => {
      if (!bridge?.imeSessionCommand) return undefined;
      let result = await bridge.imeSessionCommand({
        ...command,
        commandId: globalThis.crypto.randomUUID(),
        expectedRevision: revisionRef.current,
      } as ImeSessionCommand);
      if (result.reason === "stale-revision") {
        applySnapshot(result.snapshot);
        result = await bridge.imeSessionCommand({
          ...command,
          commandId: globalThis.crypto.randomUUID(),
          expectedRevision: revisionRef.current,
        } as ImeSessionCommand);
      }
      applySnapshot(result.snapshot);
      return result;
    },
    [applySnapshot, bridge],
  );

  useEffect(() => {
    const unsubscribe = bridge?.onImeSessionSnapshot?.(applySnapshot);
    void bridge?.getImeSessionSnapshot?.().then(applySnapshot);
    return unsubscribe;
  }, [applySnapshot, bridge]);

  const release = useCallback(async () => {
    const generation = generationRef.current;
    generationRef.current = undefined;
    setGeneration(undefined);
    focusedRef.current = false;
    setTargetEngaged(false);
    setState(EMPTY_STATE);
    releaseImeInputTarget(targetId);
    if (generation !== undefined) {
      await sendCommand({ type: "releaseTarget", targetId, generation }).catch(() => undefined);
    }
  }, [sendCommand, targetId]);

  const blur = useCallback(() => {
    bridge?.imeDiagnostic?.({
      event: "input-blur",
      targetId,
      generation: generationRef.current,
      activeElementTarget: isActiveImeInputTarget(targetId),
      documentHasFocus: document.hasFocus(),
      focusedRef: focusedRef.current,
      imeAvailable: available,
      imeEnabled,
    });
    if (document.hasFocus()) void release();
  }, [available, bridge, imeEnabled, release, targetId]);

  const acquire = useCallback(
    async (source: "input-focus" | "window-focus" = "input-focus") => {
      const focusDetails = {
        targetId,
        source,
        generation: generationRef.current,
        activeElementTarget:
          document.activeElement instanceof HTMLElement &&
          document.activeElement.dataset.imeTargetId === targetId,
        documentHasFocus: document.hasFocus(),
        focusedRef: focusedRef.current,
        imeAvailable: available,
        imeEnabled,
      };
      if (source === "input-focus")
        bridge?.imeDiagnostic?.({ event: "input-focus", ...focusDetails });
      bridge?.imeDiagnostic?.({ event: "acquire-start", ...focusDetails });
      if (!available || !enabled || !imeEnabled || !bridge?.imeSessionCommand) {
        bridge?.imeDiagnostic?.({ event: "acquire-result", ...focusDetails, accepted: false });
        return;
      }
      focusedRef.current = true;
      setTargetEngaged(true);
      activateImeInputTarget(targetId, () => void release());
      if (generationRef.current !== undefined) {
        const generation = generationRef.current;
        bridge.imeDiagnostic?.({
          event: "confirm-focus-start",
          ...focusDetails,
          generation,
          focusedRef: focusedRef.current,
        });
        const result = await sendCommand({ type: "resume", targetId, generation });
        bridge.imeDiagnostic?.({
          event: "confirm-focus-result",
          ...focusDetails,
          generation,
          focusedRef: focusedRef.current,
          accepted: Boolean(result?.accepted),
        });
        if (
          focusedRef.current &&
          result?.accepted &&
          result.snapshot.owner?.generation === generation
        ) {
          applySnapshot(result.snapshot);
        } else {
          setTargetEngaged(false);
        }
        return;
      }
      if (acquirePromiseRef.current) return acquirePromiseRef.current;
      const pendingAcquire = (async () => {
        const result = await sendCommand({ type: "acquireTarget", targetId });
        if (!result) {
          setTargetEngaged(false);
          bridge.imeDiagnostic?.({ event: "acquire-result", ...focusDetails, accepted: false });
          return;
        }
        if (!focusedRef.current) {
          setTargetEngaged(false);
          if (result.snapshot.owner?.generation !== undefined)
            await sendCommand({
              type: "releaseTarget",
              targetId,
              generation: result.snapshot.owner.generation,
            });
          bridge.imeDiagnostic?.({
            event: "acquire-result",
            ...focusDetails,
            generation: result.snapshot.owner?.generation,
            focusedRef: false,
            accepted: false,
          });
          return;
        }
        const acquiredGeneration = result.snapshot.owner?.generation;
        if (
          !result.accepted ||
          result.snapshot.owner?.targetId !== targetId ||
          acquiredGeneration === undefined
        ) {
          setTargetEngaged(false);
          if (acquiredGeneration !== undefined)
            await sendCommand({ type: "releaseTarget", targetId, generation: acquiredGeneration });
          setState(EMPTY_STATE);
          bridge.imeDiagnostic?.({
            event: "acquire-result",
            ...focusDetails,
            generation: acquiredGeneration,
            accepted: false,
          });
          return;
        }
        generationRef.current = acquiredGeneration;
        setGeneration(acquiredGeneration);
        applySnapshot(result.snapshot);
        bridge.imeDiagnostic?.({
          event: "acquire-result",
          ...focusDetails,
          generation: acquiredGeneration,
          focusedRef: focusedRef.current,
          accepted: true,
        });
      })();
      acquirePromiseRef.current = pendingAcquire;
      try {
        await pendingAcquire;
      } finally {
        if (acquirePromiseRef.current === pendingAcquire) acquirePromiseRef.current = undefined;
      }
    },
    [applySnapshot, available, bridge, enabled, imeEnabled, release, sendCommand, targetId],
  );

  useEffect(() => {
    if (!enabled || !imeEnabled || !available) void release();
  }, [available, enabled, imeEnabled, release]);

  useEffect(() => {
    const active = document.activeElement;
    bridge?.imeDiagnostic?.({
      event: "input-mounted",
      targetId,
      activeElementTarget: active instanceof HTMLElement && active.dataset.imeTargetId === targetId,
      documentHasFocus: document.hasFocus(),
      focusedRef: focusedRef.current,
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
      const active = document.activeElement;
      bridge?.imeDiagnostic?.({
        event: "document-keydown",
        targetId,
        generation: generationRef.current,
        activeElementTarget:
          active instanceof HTMLElement && active.dataset.imeTargetId === targetId,
        documentHasFocus: document.hasFocus(),
        focusedRef: focusedRef.current,
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
        generation: generationRef.current,
        key: event.key,
        keyCode: event.code,
        ctrl: event.ctrlKey,
        alt: event.altKey,
        meta: event.metaKey,
        composing: state.composing,
        documentHasFocus: document.hasFocus(),
        ...getSelectionSummary(event.target),
      });
    };
    document.addEventListener("keyup", onDocumentKeyUp, true);
    return () => {
      document.removeEventListener("keydown", onDocumentKeyDown, true);
      document.removeEventListener("keyup", onDocumentKeyUp, true);
    };
  }, [available, bridge, imeEnabled, state.composing, targetId]);

  useEffect(() => {
    const onWindowFocus = () => {
      const active = document.activeElement;
      const activeElementTarget =
        active instanceof HTMLElement && active.dataset.imeTargetId === targetId;
      bridge?.imeDiagnostic?.({
        event: "window-focus",
        targetId,
        generation: generationRef.current,
        activeElementTarget,
        documentHasFocus: document.hasFocus(),
        focusedRef: focusedRef.current,
        imeAvailable: available,
        imeEnabled,
      });
      if (activeElementTarget) void acquire("window-focus");
    };
    const onWindowBlur = () => {
      const active = document.activeElement;
      bridge?.imeDiagnostic?.({
        event: "window-blur",
        targetId,
        generation: generationRef.current,
        activeElementTarget:
          active instanceof HTMLElement && active.dataset.imeTargetId === targetId,
        documentHasFocus: document.hasFocus(),
        focusedRef: focusedRef.current,
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
  }, [acquire, available, bridge, imeEnabled, targetId]);

  useEffect(() => () => void release(), [release]);

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
      if (!isActiveImeInputTarget(targetId) || !focusedRef.current) return;
      void enqueueImeInput(targetId, async (latest) => {
        if (latest) applySnapshot(latest);
        if (generationRef.current === undefined) await acquirePromiseRef.current;
        const generation = generationRef.current;
        if (generation === undefined || !focusedRef.current) return;
        const currentSnapshot = getLatestImeSessionSnapshot() ?? latest;
        if (currentSnapshot) applySnapshot(currentSnapshot);
        const editorCommand = routeLatest?.(currentSnapshot);
        if (editorCommand === "ignored") return;
        if (editorCommand) {
          applyEditorCommand?.(editorCommand);
          return;
        }
        const result = await request(generation, currentSnapshot);
        if (!result?.accepted || generationRef.current !== generation || !focusedRef.current)
          return;
        applySnapshot(result.snapshot);
        if (result.commit) onCommitRef.current?.(result.commit.text);
        else if (result.engineHandled === false) {
          applyFallback?.(result);
          const fallback = routeLatest?.(result.snapshot);
          if (fallback && fallback !== "ignored") applyEditorCommand?.(fallback);
        }
      }).catch((error: unknown) => console.error("[ime-ui] key processing failed", error));
    },
    [applySnapshot, targetId],
  );

  const sendKey = useCallback(
    (
      event: KeyboardEvent | React.KeyboardEvent<HTMLElement>,
      release = false,
      applyEditorCommand?: (command: ImeEditorCommand) => void,
    ) => {
      const activeElement = document.activeElement;
      const keyKind = getKeyKind(event.key);
      const reportRouting = (accepted: boolean) => {
        const modifierKey = ["Control", "Shift", "Alt", "Meta"].includes(event.key);
        const selection = getSelectionSummary(event.target);
        const hasModifier = event.ctrlKey || event.altKey || event.metaKey;
        const isEditingKey =
          (event.key === "Backspace" || event.key === "Delete") &&
          (!state.composing || (selection.selectionLength ?? 0) > 0);
        if (modifierKey || (!hasModifier && !isEditingKey)) return;
        bridge?.imeDiagnostic?.({
          event: "key-routing",
          targetId,
          generation: generationRef.current,
          activeElementTarget:
            activeElement instanceof HTMLElement && activeElement.dataset.imeTargetId === targetId,
          documentHasFocus: document.hasFocus(),
          focusedRef: focusedRef.current,
          imeAvailable: available,
          imeEnabled,
          composing: state.composing,
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
      if (!focusedRef.current) {
        reportRouting(false);
        return false;
      }
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
        ].includes(event.key);
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
            const engine = latest.engine;
            const route = resolveImeKeyRoute(routingEvent, {
              inputMode: engine.inputMode,
              composing: engine.composing,
            });
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
        { inputMode: asciiModeRef.current ? "ascii" : "chinese", composing: state.composing },
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
          if (!keyEvent.text || result.engineHandled !== false) return;
          const engine = result.snapshot.engine;
          const chineseNumericFallback =
            engine.inputMode === "chinese" &&
            !engine.composing &&
            /^[0-9]$/.test(keyEvent.key) &&
            !keyEvent.shift &&
            !keyEvent.ctrl &&
            !keyEvent.alt &&
            !keyEvent.meta;
          const printableFallback =
            engine.inputMode === "ascii" &&
            keyEvent.text !== undefined &&
            !keyEvent.ctrl &&
            !keyEvent.alt &&
            !keyEvent.meta;
          if (printableFallback || chineseNumericFallback) onCommitRef.current?.(keyEvent.text);
        },
      );
      reportRouting(true);
      return true;
    },
    [available, bridge, enabled, enqueueInput, imeEnabled, sendCommand, state, targetId],
  );

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
    if (!bridge?.imeSessionCommand) {
      setState(EMPTY_STATE);
      return;
    }
    enqueueInput((generation) => sendCommand({ type: "cancelComposition", targetId, generation }));
  }, [bridge, enqueueInput, sendCommand, targetId]);

  useEffect(() => {
    if (!available || !enabled) return;
    return bridge?.onImeCandidateAction?.((action) => {
      if (
        generationRef.current === undefined ||
        action.generation !== generationRef.current ||
        action.targetId !== targetId ||
        !isActiveImeInputTarget(targetId) ||
        !focusedRef.current
      )
        return;
      if (action.type === "select") select(action.index);
      else sendNavigation(action.key);
    });
  }, [available, bridge, enabled, select, sendNavigation, targetId]);

  const updateCandidate = useCallback(
    (payload: ImeCandidateUpdate) => {
      const generation = generationRef.current;
      if (payload.type === "show" && generation !== undefined)
        bridge?.setImeCandidate?.({ ...payload, targetId, generation });
      else if (payload.type !== "show")
        bridge?.setImeCandidate?.({
          ...payload,
          targetId,
          ...(generation !== undefined ? { generation } : {}),
        });
    },
    [bridge, targetId],
  );

  const toggle = useCallback(() => setImeEnabled((current) => !current), []);
  const textPolicy = resolveImeTextPolicy({
    targetOwned: targetEngaged,
    inputMode: asciiMode ? "ascii" : "chinese",
    composing: state.composing,
  });

  return {
    available: enabled && available,
    imeEnabled,
    asciiMode,
    targetEngaged,
    textPolicy,
    shouldPreventBeforeInput: (inputType: string) =>
      shouldPreventImeBeforeInput(textPolicy, inputType),
    active: enabled && imeEnabled && available && state.enabled,
    state,
    generation,
    acquire,
    release,
    blur,
    sendKey,
    sendKeyUp,
    sendNavigation,
    select,
    cancelComposition,
    updateCandidate,
    toggle,
  };
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
