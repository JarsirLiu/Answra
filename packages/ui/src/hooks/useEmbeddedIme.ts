import type {
  DesktopBridge,
  ImeCandidateAction,
  ImeCandidateAnchor,
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
  const disableTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    onCommitRef.current = onCommit;
  }, [onCommit]);

  useEffect(() => {
    if (disableTimerRef.current !== undefined) {
      window.clearTimeout(disableTimerRef.current);
      disableTimerRef.current = undefined;
    }
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
      // React StrictMode replays mount effects. Defer shutdown one task so the
      // replacement effect can cancel it instead of disabling the shared Rime session.
      disableTimerRef.current = window.setTimeout(() => {
        disableTimerRef.current = undefined;
        void bridge?.imeEnable?.(false);
      }, 0);
    };
  }, [available, bridge, enabled, imeEnabled]);

  useEffect(() => {
    if (!state.enabled) return;
    const pending = document.querySelector<HTMLTextAreaElement>("[data-ime-focus-pending='true']");
    if (!pending) return;
    delete pending.dataset.imeFocusPending;
    pending.focus();
  }, [state.enabled]);

  const sendKey = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (!available || !enabled || !state.enabled || !bridge?.imeKey) return false;
      if (event.key === "Backspace" && !state.composing) return false;
      if ((event.ctrlKey || event.altKey || event.metaKey) && !state.composing) return false;
      const key = normalizeKey(event.key, event.code);
      if (!key || (key.length !== 1 && !state.composing)) return false;
      const request: ImeKeyRequest = {
        key,
        code: event.code,
        shift: event.shiftKey,
        ctrl: event.ctrlKey,
        alt: event.altKey,
        meta: event.metaKey,
      };
      console.info("[ime-ui] dispatch key", { key, code: event.code });
      void bridge.imeKey(request).then((next) => {
        setState(next);
        if (next.committedText) onCommitRef.current?.(next.committedText);
        return next;
      });
      return true;
    },
    [available, bridge, enabled, state.composing, state.enabled],
  );

  const sendNavigation = useCallback(
    (key: string) => {
      if (!available || !enabled || !state.enabled || !bridge?.imeKey) return;
      const request: ImeKeyRequest = {
        key,
        code: key,
        shift: false,
        ctrl: false,
        alt: false,
        meta: false,
      };
      void bridge.imeKey(request).then((next) => {
        setState(next);
        if (next.committedText) onCommitRef.current?.(next.committedText);
      });
    },
    [available, bridge, enabled, state.enabled],
  );

  const select = useCallback(
    (index: number) => {
      if (!bridge?.imeSelect) return;
      void bridge.imeSelect(index).then((next) => {
        setState(next);
        if (next.committedText) onCommitRef.current?.(next.committedText);
      });
    },
    [bridge],
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
    (payload: { state: ImeState; anchor: ImeCandidateAnchor } | null) => {
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
