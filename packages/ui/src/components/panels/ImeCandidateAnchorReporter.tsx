import type { ImeCandidateAnchor, ImeState } from "@answra/shared";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";

interface ImeCandidateAnchorReporterProps {
  state: ImeState;
  onUpdate: (payload: { state: ImeState; anchor: ImeCandidateAnchor } | null) => void;
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
  const bump = useCallback(() => setTick((current) => current + 1), []);

  const handleFocus = useCallback((event: FocusEvent) => {
    if (event.type === "focusout") {
      setAnchor(null);
      return;
    }
    const target = event.target;
    setAnchor(
      target instanceof HTMLTextAreaElement && target.matches("[data-embedded-ime-target]")
        ? target
        : null,
    );
  }, []);

  useEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement && active.matches("[data-embedded-ime-target]")) {
      setAnchor(active);
    }
    document.addEventListener("focusin", handleFocus, true);
    document.addEventListener("focusout", handleFocus, true);
    window.addEventListener("resize", bump);
    return () => {
      document.removeEventListener("focusin", handleFocus, true);
      document.removeEventListener("focusout", handleFocus, true);
      window.removeEventListener("resize", bump);
    };
  }, [bump, handleFocus]);

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
    if (!visible || !anchor) {
      onUpdate(null);
      return;
    }
    const composition = measureComposition(anchor, state.preedit.length);
    if (!composition) {
      onUpdate(null);
      return;
    }
    onUpdate({ state, anchor: composition });
  }, [anchor, onUpdate, state, tick, visible]);

  useEffect(() => () => onUpdate(null), [onUpdate]);
  return null;
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
