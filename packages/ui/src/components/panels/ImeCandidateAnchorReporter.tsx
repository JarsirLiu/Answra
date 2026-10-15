import type { ImeCandidateAnchor, ImeCandidateUpdate, ImeState } from "@answra/shared";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import "./ImeCandidateAnchorReporter.css";

interface ImeCandidateAnchorReporterProps {
  state: ImeState;
  targetId: string;
  generation?: number;
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

/** Publishes the focused editor's current caret as the native candidate anchor. */
export function ImeCandidateAnchorReporter({
  state,
  targetId,
  generation,
  onUpdate,
}: ImeCandidateAnchorReporterProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [caretAnchor, setCaretAnchor] = useState<ImeCandidateAnchor | null>(null);
  const [windowFocused, setWindowFocused] = useState(true);
  const [tick, setTick] = useState(0);
  const lastFocusedAnchor = useRef<HTMLElement | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const bump = useCallback(() => setTick((current) => current + 1), []);

  const handleFocus = useCallback(
    (event: FocusEvent) => {
      if (event.type === "focusout") {
        if (!document.hasFocus() || stateRef.current.composing) return;
        setAnchor(null);
        return;
      }
      const next = resolveAnchor(event.target, targetId);
      if (next) lastFocusedAnchor.current = next;
      setAnchor(next);
    },
    [targetId],
  );

  const refreshFocusedAnchor = useCallback(() => {
    setWindowFocused(true);
    let next = resolveAnchor(document.activeElement, targetId);
    if (
      !next &&
      (document.activeElement === document.body ||
        document.activeElement === document.documentElement)
    ) {
      const previous = lastFocusedAnchor.current;
      if (previous?.isConnected && previous.dataset.imeTargetId === targetId) {
        previous.focus({ preventScroll: true });
        next = previous;
      }
    }
    if (next) lastFocusedAnchor.current = next;
    setAnchor(next);
    bump();
  }, [bump, targetId]);

  const handleWindowBlur = useCallback(() => {
    setWindowFocused(false);
    setCaretAnchor(null);
  }, []);

  useEffect(() => {
    setAnchor(resolveAnchor(document.activeElement, targetId));
    document.addEventListener("focusin", handleFocus, true);
    document.addEventListener("focusout", handleFocus, true);
    window.addEventListener("resize", bump);
    window.addEventListener("focus", refreshFocusedAnchor);
    window.addEventListener("blur", handleWindowBlur);
    document.addEventListener("selectionchange", bump);
    document.addEventListener("keyup", bump, true);
    document.addEventListener("pointerup", bump, true);
    return () => {
      document.removeEventListener("focusin", handleFocus, true);
      document.removeEventListener("focusout", handleFocus, true);
      window.removeEventListener("resize", bump);
      window.removeEventListener("focus", refreshFocusedAnchor);
      window.removeEventListener("blur", handleWindowBlur);
      document.removeEventListener("selectionchange", bump);
      document.removeEventListener("keyup", bump, true);
      document.removeEventListener("pointerup", bump, true);
    };
  }, [bump, handleFocus, handleWindowBlur, refreshFocusedAnchor, targetId]);

  useEffect(() => {
    if (!anchor) return;
    window.addEventListener("scroll", bump, true);
    return () => window.removeEventListener("scroll", bump, true);
  }, [anchor, bump]);

  const visible = Boolean(
    state.enabled && anchor && (state.preedit.length > 0 || state.candidates.length > 0),
  );

  // The selected position changes with Rime preedit and DOM selection events.
  // biome-ignore lint/correctness/useExhaustiveDependencies: state.preedit and tick invalidate measured caret geometry.
  useLayoutEffect(() => {
    if (
      !windowFocused ||
      !anchor ||
      anchor !== document.activeElement ||
      (!(anchor instanceof HTMLInputElement) && !(anchor instanceof HTMLTextAreaElement)) ||
      !anchor.readOnly
    ) {
      setCaretAnchor(null);
      return;
    }
    const next = measureAnchor(anchor, 0);
    setCaretAnchor((current) =>
      current?.x === next?.x &&
      current?.lineTop === next?.lineTop &&
      current?.lineBottom === next?.lineBottom
        ? current
        : (next ?? null),
    );
  }, [anchor, state.preedit, tick, windowFocused]);

  // Scroll and resize invalidate caret geometry without changing the focused element.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick is the explicit layout invalidation signal.
  useLayoutEffect(() => {
    if (!anchor || anchor.dataset.imeTargetId !== targetId || generation === undefined) {
      if (state.enabled && state.composing) return;
      onUpdate({
        type: "clear",
        state,
        targetId,
        ...(generation !== undefined ? { generation } : {}),
      });
      return;
    }
    if (!visible) {
      if (state.enabled && state.composing) return;
      onUpdate({ type: "clear", state, targetId, generation });
      return;
    }
    const position = measureAnchor(anchor, state.preedit.length);
    if (!position) return;
    onUpdate({ type: "show", state, anchor: position, targetId, generation });
  }, [anchor, generation, onUpdate, state, targetId, tick, visible]);

  useEffect(
    () => () =>
      onUpdate({ type: "clear", targetId, ...(generation !== undefined ? { generation } : {}) }),
    [generation, onUpdate, targetId],
  );
  return caretAnchor && windowFocused ? (
    <span
      aria-hidden="true"
      className="ime-visual-caret"
      data-ime-visual-caret="true"
      style={{
        height: Math.max(1, caretAnchor.lineBottom - caretAnchor.lineTop),
        left: caretAnchor.x,
        top: caretAnchor.lineTop,
      }}
    />
  ) : null;
}

function resolveAnchor(target: EventTarget | null, targetId: string): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest<HTMLElement>("[data-ime-policy='text'][data-ime-target-id]");
  if (
    !element ||
    element.dataset.imeTargetId !== targetId ||
    !(
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element.isContentEditable
    )
  )
    return null;
  return element;
}

function measureAnchor(
  element: HTMLElement,
  preeditLength: number,
): ImeCandidateAnchor | undefined {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const caret = element.selectionStart ?? element.value.length;
    const hasInlinePreedit = element.dataset.imePreeditInValue === "true";
    const position = hasInlinePreedit ? Math.max(0, caret - preeditLength) : caret;
    return measureInputCaret(element, position);
  }
  const selection = window.getSelection();
  if (selection?.rangeCount) {
    const range = selection.getRangeAt(0).cloneRange();
    range.collapse(false);
    const rect = range.getBoundingClientRect();
    if (rect.width || rect.height)
      return { x: rect.left, lineTop: rect.top, lineBottom: rect.bottom };
  }
  const rect = element.getBoundingClientRect();
  return { x: rect.left, lineTop: rect.top, lineBottom: rect.bottom };
}

function measureInputCaret(
  element: HTMLInputElement | HTMLTextAreaElement,
  position: number,
): ImeCandidateAnchor {
  const style = window.getComputedStyle(element);
  const mirror = document.createElement("div");
  for (const key of MIRROR_STYLE_KEYS) mirror.style[key] = style[key];
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  if (element instanceof HTMLInputElement) mirror.style.whiteSpace = "pre";
  mirror.textContent = element.value.slice(0, position);
  const marker = document.createElement("span");
  marker.textContent = element.value.slice(position) || "\u200b";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const lineHeight = Number.parseFloat(style.lineHeight);
  const lineSpan = Number.isFinite(lineHeight) ? lineHeight : marker.offsetHeight;
  const x = marker.offsetLeft;
  const lineTop = marker.offsetTop;
  document.body.removeChild(mirror);
  const rect = element.getBoundingClientRect();
  return {
    x: rect.left + x - element.scrollLeft,
    lineTop: rect.top + lineTop - element.scrollTop,
    lineBottom: rect.top + lineTop + lineSpan - element.scrollTop,
  };
}
