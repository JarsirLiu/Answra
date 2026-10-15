import type {
  DesktopBridge,
  ImeCandidateAction,
  ImeCandidateUpdate,
  ImeKeyRequest,
  ImeState,
} from "@answra/shared";
import { useCallback, useEffect, useRef, useState } from "react";

const EMPTY_STATE: ImeState = {
  enabled: false,
  composing: false,
  preedit: "",
  candidates: [],
  selectedIndex: 0,
  page: 0,
  hasNextPage: false,
};

/** Coordinates the optional native IME without changing the editor's draft state. */
export function useEmbeddedIme(
  bridge: DesktopBridge | undefined,
  onCommit?: (text: string) => void,
  enabled = true,
) {
  const available = Boolean(
    bridge?.imeAvailable && bridge.imeKey && bridge.imeEnable && bridge.imeSelect,
  );
  const [imeEnabled, setImeEnabled] = useState(true);
  const [state, setState] = useState<ImeState>(EMPTY_STATE);
  const onCommitRef = useRef(onCommit);
  const inputQueueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    onCommitRef.current = onCommit;
  }, [onCommit]);

  const enqueueInput = useCallback((request: () => Promise<ImeState>) => {
    inputQueueRef.current = inputQueueRef.current
      .catch(() => undefined)
      .then(request)
      .then((next) => {
        setState(next);
        if (next.committedText) onCommitRef.current?.(next.committedText);
      })
      .catch((error: unknown) => console.error("[ime-ui] key processing failed", error));
  }, []);

  useEffect(() => {
    console.info("[ime-ui] bridge", { available, enabled, imeEnabled });
    if (!available || !enabled || !imeEnabled) {
      setState(EMPTY_STATE);
      if (available && (!enabled || !imeEnabled)) void bridge?.imeEnable?.(false);
      return;
    }
    const unsubscribe = bridge?.onImeChange?.(setState);
    let retryTimer: number | undefined;
    const enable = () =>
      bridge
        ?.imeEnable?.(true)
        .then((next) => {
          setState(next);
          if (!next.enabled && retryTimer === undefined)
            retryTimer = window.setInterval(() => void enable(), 250);
          if (next.enabled && retryTimer !== undefined) {
            window.clearInterval(retryTimer);
            retryTimer = undefined;
          }
          console.info("[ime-ui] session", { available, enabled: next.enabled });
        })
        .catch((error: unknown) => console.error("[ime-ui] enable failed", error));
    void enable();
    return () => {
      if (retryTimer !== undefined) window.clearInterval(retryTimer);
      unsubscribe?.();
    };
  }, [available, bridge, enabled, imeEnabled]);

  useEffect(() => {
    if (!state.enabled) return;
    const pending = document.querySelector<HTMLElement>("[data-ime-focus-pending='true']");
    if (!pending) return;
    delete pending.dataset.imeFocusPending;
    pending.focus();
  }, [state.enabled]);

  useEffect(() => {
    if (!available || !enabled || !imeEnabled || !bridge?.imeEnable) return;
    const restoreChineseMode = () => {
      void bridge
        .imeEnable?.(true)
        .then(setState)
        .catch((error: unknown) => console.error("[ime-ui] focus restore failed", error));
    };
    window.addEventListener("focus", restoreChineseMode);
    return () => window.removeEventListener("focus", restoreChineseMode);
  }, [available, bridge, enabled, imeEnabled]);

  const sendKey = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (!available || !enabled || !state.enabled || !bridge?.imeKey) return false;
      if (event.key === "Backspace" && !state.composing) return false;
      if ((event.ctrlKey || event.altKey || event.metaKey) && !state.composing) return false;
      const key = normalizeKey(event.key, event.code);
      if (!key || (key.length !== 1 && !state.composing)) return false;
      const imeKey = bridge.imeKey;
      const request: ImeKeyRequest = {
        key,
        code: event.code,
        shift: event.shiftKey,
        ctrl: event.ctrlKey,
        alt: event.altKey,
        meta: event.metaKey,
      };
      enqueueInput(() => imeKey(request));
      return true;
    },
    [available, bridge, enabled, enqueueInput, state.composing, state.enabled],
  );

  const sendNavigation = useCallback(
    (key: string) => {
      if (!available || !enabled || !state.enabled || !bridge?.imeKey) return;
      const imeKey = bridge.imeKey;
      const request: ImeKeyRequest = {
        key,
        code: key,
        shift: false,
        ctrl: false,
        alt: false,
        meta: false,
      };
      enqueueInput(() => imeKey(request));
    },
    [available, bridge, enabled, enqueueInput, state.enabled],
  );

  const select = useCallback(
    (index: number) => {
      if (!bridge?.imeSelect) return;
      const imeSelect = bridge.imeSelect;
      enqueueInput(() => imeSelect(index));
    },
    [bridge, enqueueInput],
  );

  const sendCandidateAction = useCallback(
    (action: ImeCandidateAction) => {
      if (action.type === "select") select(action.index);
      else sendNavigation(action.key);
    },
    [select, sendNavigation],
  );

  useEffect(() => {
    if (!available || !enabled) return;
    return bridge?.onImeCandidateAction?.(sendCandidateAction);
  }, [available, bridge, enabled, sendCandidateAction]);

  const updateCandidate = useCallback(
    (payload: ImeCandidateUpdate) => {
      bridge?.setImeCandidate?.(payload);
    },
    [bridge],
  );

  return {
    available: enabled && available,
    imeEnabled,
    active: enabled && imeEnabled && available && state.enabled,
    state,
    sendKey,
    sendNavigation,
    select,
    updateCandidate,
    toggle: () => setImeEnabled((current) => !current),
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
