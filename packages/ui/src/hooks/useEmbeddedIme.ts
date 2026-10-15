import type { DesktopBridge, ImeCandidateUpdate, ImeKeyRequest, ImeState } from "@answra/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  activateImeInputTarget,
  isActiveImeInputTarget,
  releaseImeInputTarget,
} from "../ime/imeInputTargetCoordinator";

const EMPTY_STATE: ImeState = {
  enabled: false,
  composing: false,
  preedit: "",
  candidates: [],
  selectedIndex: 0,
  page: 0,
  hasNextPage: false,
};

/** Registers one input target with the main-owned session when its editor receives focus. */
export function useEmbeddedIme(
  bridge: DesktopBridge | undefined,
  onCommit?: (text: string) => void,
  enabled = true,
  targetId = "conversation-composer",
) {
  const available = Boolean(
    bridge?.imeAvailable && bridge.imeKey && bridge.imeAcquire && bridge.imeRelease,
  );
  const [imeEnabled, setImeEnabled] = useState(true);
  const [state, setState] = useState<ImeState>(EMPTY_STATE);
  const [generation, setGeneration] = useState<number | undefined>(undefined);
  const generationRef = useRef<number | undefined>(undefined);
  const focusedRef = useRef(false);
  const onCommitRef = useRef(onCommit);
  const inputQueueRef = useRef<Promise<void>>(Promise.resolve());
  const acquirePromiseRef = useRef<Promise<void> | undefined>(undefined);
  onCommitRef.current = onCommit;

  const release = useCallback(async () => {
    const generation = generationRef.current;
    generationRef.current = undefined;
    setGeneration(undefined);
    focusedRef.current = false;
    setState(EMPTY_STATE);
    releaseImeInputTarget(targetId);
    if (generation !== undefined) {
      const pendingRelease = bridge?.imeRelease?.(generation);
      await pendingRelease?.catch(() => undefined);
    }
  }, [bridge, targetId]);

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
      if (!available || !enabled || !imeEnabled || !bridge?.imeAcquire) {
        bridge?.imeDiagnostic?.({ event: "acquire-result", ...focusDetails, accepted: false });
        return;
      }
      focusedRef.current = true;
      activateImeInputTarget(targetId, () => void release());
      if (generationRef.current !== undefined) {
        const generation = generationRef.current;
        bridge.imeDiagnostic?.({
          event: "confirm-focus-start",
          ...focusDetails,
          generation,
          focusedRef: focusedRef.current,
        });
        const result = await bridge.imeConfirmFocus?.(targetId, generation);
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
          result.targetId === targetId &&
          result.generation === generation
        )
          setState(result.state);
        return;
      }
      if (acquirePromiseRef.current) return acquirePromiseRef.current;
      const pendingAcquire = (async () => {
        const result = await bridge.imeAcquire?.(targetId);
        if (!result) {
          bridge.imeDiagnostic?.({ event: "acquire-result", ...focusDetails, accepted: false });
          return;
        }
        if (!focusedRef.current) {
          if (result.generation !== undefined) await bridge.imeRelease?.(result.generation);
          bridge.imeDiagnostic?.({
            event: "acquire-result",
            ...focusDetails,
            generation: result.generation,
            focusedRef: false,
            accepted: false,
          });
          return;
        }
        if (!result.accepted || result.targetId !== targetId || result.generation === undefined) {
          if (result.generation !== undefined) await bridge.imeRelease?.(result.generation);
          setState(EMPTY_STATE);
          bridge.imeDiagnostic?.({
            event: "acquire-result",
            ...focusDetails,
            generation: result.generation,
            accepted: false,
          });
          return;
        }
        generationRef.current = result.generation;
        setGeneration(result.generation);
        setState(result.state);
        bridge.imeDiagnostic?.({
          event: "acquire-result",
          ...focusDetails,
          generation: result.generation,
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
    [available, bridge, enabled, imeEnabled, release, targetId],
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
    (request: (generation: number) => Promise<ImeState>) => {
      if (!isActiveImeInputTarget(targetId) || !focusedRef.current) return;
      inputQueueRef.current = inputQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          if (generationRef.current === undefined) await acquirePromiseRef.current;
          const generation = generationRef.current;
          if (generation === undefined) return;
          if (generationRef.current !== generation || !focusedRef.current) return;
          const next = await request(generation);
          if (generationRef.current !== generation || !focusedRef.current) return;
          setState(next);
          if (next.committedText) onCommitRef.current?.(next.committedText);
        })
        .catch((error: unknown) => console.error("[ime-ui] key processing failed", error));
    },
    [targetId],
  );

  const sendKey = useCallback(
    (event: KeyboardEvent | React.KeyboardEvent<HTMLElement>) => {
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
        !bridge?.imeKey ||
        !isActiveImeInputTarget(targetId)
      ) {
        reportRouting(false);
        return false;
      }
      if (!focusedRef.current) {
        reportRouting(false);
        return false;
      }
      if (event.key === "Backspace" && !state.composing) {
        reportRouting(false);
        return false;
      }
      if ((event.ctrlKey || event.altKey || event.metaKey) && !state.composing) {
        reportRouting(false);
        return false;
      }
      const key = normalizeKey(event.key, event.code);
      if (!key || (key.length !== 1 && !state.composing)) {
        reportRouting(false);
        return false;
      }
      const request: ImeKeyRequest = {
        generation: generationRef.current ?? -1,
        key,
        code: event.code,
        shift: event.shiftKey,
        ctrl: event.ctrlKey,
        alt: event.altKey,
        meta: event.metaKey,
      };
      enqueueInput(
        (generation) => bridge.imeKey?.({ ...request, generation }) ?? Promise.resolve(EMPTY_STATE),
      );
      reportRouting(true);
      return true;
    },
    [available, bridge, enabled, enqueueInput, imeEnabled, state.composing, targetId],
  );

  const sendNavigation = useCallback(
    (key: string) => {
      if (!bridge?.imeKey) return;
      enqueueInput(
        (generation) =>
          bridge.imeKey?.({
            generation,
            key,
            code: key,
            shift: false,
            ctrl: false,
            alt: false,
            meta: false,
          }) ?? Promise.resolve(EMPTY_STATE),
      );
    },
    [bridge, enqueueInput],
  );

  const select = useCallback(
    (index: number) => {
      if (!bridge?.imeSelect) return;
      enqueueInput(
        (generation) => bridge.imeSelect?.(index, generation) ?? Promise.resolve(EMPTY_STATE),
      );
    },
    [bridge, enqueueInput],
  );

  const cancelComposition = useCallback(() => {
    if (!bridge?.imeReset) {
      setState(EMPTY_STATE);
      return;
    }
    enqueueInput((generation) => bridge.imeReset?.(generation) ?? Promise.resolve(EMPTY_STATE));
  }, [bridge, enqueueInput]);

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

  return {
    available: enabled && available,
    imeEnabled,
    active: enabled && imeEnabled && available && state.enabled,
    state,
    generation,
    acquire,
    release,
    blur,
    sendKey,
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

/** Windows marks keys consumed by its IME as "Process"; recover the physical key. */
function normalizeKey(key: string, code: string): string | undefined {
  if (key !== "Process") return key;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
  return undefined;
}
