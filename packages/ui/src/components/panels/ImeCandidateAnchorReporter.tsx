import type { ImeCandidateAnchor, ImeCandidateUpdate, ImeState } from "@answra/shared";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

interface ImeCandidateAnchorReporterProps {
  state: ImeState;
  onUpdate: (payload: ImeCandidateUpdate) => void;
}

const MIRROR_STYLE_KEYS = [
  "border",
  "boxSizing",
  "direction",
  "fontFamily",
  "fontSize",
  "fontStyle",
  "fontWeight",
  "letterSpacing",
  "lineHeight",
  "overflowWrap",
  "padding",
  "tabSize",
  "textIndent",
  "textTransform",
  "whiteSpace",
  "width",
  "wordBreak",
] as const;

/** Reports composition geometry to the main process; the native candidate window owns popup UI. */
export function ImeCandidateAnchorReporter({ state, onUpdate }: ImeCandidateAnchorReporterProps) {
  const [anchor, setAnchor] = useState<HTMLTextAreaElement | null>(null);
  const [tick, setTick] = useState(0);
  const lastFocusedAnchor = useRef<HTMLTextAreaElement | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const bump = useCallback(() => setTick((current) => current + 1), []);

  const handleFocus = useCallback((event: FocusEvent) => {
    if (event.type === "focusout") {
      // BrowserWindow blur can happen while Electron shows the candidate
      // surface. Keep an active composition anchored until main confirms the
      // app left foreground; a DOM focusout alone is not an app deactivation.
      if (!document.hasFocus() || stateRef.current.composing) return;
      setAnchor(null);
      return;
    }
    const nextAnchor = resolveAnchor(event.target);
    if (nextAnchor) lastFocusedAnchor.current = nextAnchor;
    setAnchor(nextAnchor);
  }, []);
  const refreshFocusedAnchor = useCallback(() => {
    let nextAnchor = resolveAnchor(document.activeElement);
    if (
      !nextAnchor &&
      (document.activeElement === document.body ||
        document.activeElement === document.documentElement)
    ) {
      const previous = lastFocusedAnchor.current;
      if (previous?.isConnected && previous.matches("[data-embedded-ime-target]")) {
        previous.focus({ preventScroll: true });
        nextAnchor = previous;
      }
    }
    if (nextAnchor) lastFocusedAnchor.current = nextAnchor;
    setAnchor(nextAnchor);
    bump();
  }, [bump]);

  useEffect(() => {
    setAnchor(resolveAnchor(document.activeElement));
    document.addEventListener("focusin", handleFocus, true);
    document.addEventListener("focusout", handleFocus, true);
    window.addEventListener("resize", bump);
    window.addEventListener("focus", refreshFocusedAnchor);
    return () => {
      document.removeEventListener("focusin", handleFocus, true);
      document.removeEventListener("focusout", handleFocus, true);
      window.removeEventListener("resize", bump);
      window.removeEventListener("focus", refreshFocusedAnchor);
    };
  }, [bump, handleFocus, refreshFocusedAnchor]);

  useEffect(() => {
    if (!anchor) return;
    window.addEventListener("scroll", bump, true);
    return () => window.removeEventListener("scroll", bump, true);
  }, [anchor, bump]);

  const visible = Boolean(
    state.enabled && anchor && (state.preedit.length > 0 || state.candidates.length > 0),
  );

  // Scroll and resize invalidate caret geometry without changing the focused element.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick is the explicit layout invalidation signal.
  useLayoutEffect(() => {
    if (!anchor) {
      if (state.enabled && state.composing) return;
      onUpdate({ type: "clear", state });
      return;
    }
    if (!visible) {
      if (state.enabled && state.composing) return;
      onUpdate({ type: "clear", state });
      return;
    }
    const composition = measureComposition(anchor, state.preedit.length);
    if (!composition) {
      return;
    }
    onUpdate({ type: "show", state, anchor: composition });
  }, [anchor, onUpdate, state, tick, visible]);

  useEffect(() => () => onUpdate({ type: "clear" }), [onUpdate]);
  return null;
}

function resolveAnchor(target: EventTarget | null): HTMLTextAreaElement | null {
  if (!(target instanceof HTMLTextAreaElement)) return null;
  return target.matches("[data-embedded-ime-target]") ? target : null;
}

function measureComposition(
  textarea: HTMLTextAreaElement,
  preeditLength: number,
): ImeCandidateAnchor | undefined {
  const caret = textarea.selectionStart ?? textarea.value.length;
  const compositionStart = Math.max(0, caret - preeditLength);
  const style = window.getComputedStyle(textarea);
  const mirror = document.createElement("div");
  for (const key of MIRROR_STYLE_KEYS) mirror.style[key] = style[key];
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.textContent = textarea.value.slice(0, compositionStart);
  const marker = document.createElement("span");
  marker.textContent = textarea.value.slice(compositionStart) || "\u200b";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const lineHeight = Number.parseFloat(style.lineHeight);
  const lineSpan = Number.isFinite(lineHeight) ? lineHeight : marker.offsetHeight;
  const x = marker.offsetLeft;
  const lineTop = marker.offsetTop;
  document.body.removeChild(mirror);
  const rect = textarea.getBoundingClientRect();
  return {
    x: rect.left + x - textarea.scrollLeft,
    lineTop: rect.top + lineTop - textarea.scrollTop,
    lineBottom: rect.top + lineTop + lineSpan - textarea.scrollTop,
  };
}
