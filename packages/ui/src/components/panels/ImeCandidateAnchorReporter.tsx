import type { ImeCandidateAnchor, ImeCandidateUpdate, ImeState } from "@answra/shared";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import "./ImeCandidateAnchorReporter.css";

interface ImeCandidateAnchorReporterProps {
  state: ImeState;
  targetId: string;
  generation?: number;
  /**
   * Derived from `imeTextPolicy.blockNativeEditing` by the owning editor. While the
   * target is leased the browser caret is suppressed, so the reporter draws its own.
   * The reporter must not sniff DOM `readOnly`: that attribute also carries business
   * read-only/disabled intent and is not the single writer of this fact.
   */
  blockNativeEditing?: boolean;
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
  blockNativeEditing = false,
  onUpdate,
}: ImeCandidateAnchorReporterProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [caretAnchor, setCaretAnchor] = useState<ImeCandidateAnchor | null>(null);
  const [tick, setTick] = useState(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const bump = useCallback(() => setTick((current) => current + 1), []);
  // Window focus is a DOM fact with a single owner (the browser). Read it on demand
  // instead of caching a copy; a render is scheduled by the focus/blur listeners below.
  const windowFocused = document.hasFocus();

  const handleFocus = useCallback(
    (event: FocusEvent) => {
      if (event.type === "focusout") {
        if (!document.hasFocus() || stateRef.current.composing) return;
        setAnchor(null);
        return;
      }
      const next = resolveAnchor(event.target, targetId);
      setAnchor(next);
    },
    [targetId],
  );

  const refreshFocusedAnchor = useCallback(() => {
    const next = resolveAnchor(document.activeElement, targetId);
    setAnchor(next);
    bump();
  }, [bump, targetId]);

  // Window blur invalidates the visual caret; the derived `windowFocused` read then
  // hides it. This must not `bump()`: `tick` also invalidates candidate publishing,
  // and a blurred window must not re-assert a candidate anchor.
  const handleWindowBlur = useCallback(() => setCaretAnchor(null), []);

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

  const visible = Boolean(state.enabled && anchor && state.candidates.length > 0);

  // Selection, scroll, and resize changes invalidate the measured caret geometry.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick is the explicit layout invalidation signal.
  useLayoutEffect(() => {
    if (
      !windowFocused ||
      generation === undefined ||
      !anchor ||
      anchor !== document.activeElement ||
      (!(anchor instanceof HTMLInputElement) && !(anchor instanceof HTMLTextAreaElement)) ||
      anchor.disabled ||
      !blockNativeEditing
    ) {
      setCaretAnchor(null);
      return;
    }
    const next = measureAnchor(anchor);
    setCaretAnchor((current) =>
      current?.x === next?.x &&
      current?.lineTop === next?.lineTop &&
      current?.lineBottom === next?.lineBottom
        ? current
        : (next ?? null),
    );
  }, [anchor, blockNativeEditing, generation, tick, windowFocused]);

  // Scroll and resize invalidate caret geometry without changing the focused element.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick is the explicit layout invalidation signal.
  useLayoutEffect(() => {
    if (!anchor || anchor.dataset.imeTargetId !== targetId || generation === undefined) {
      onUpdate({
        type: "clear",
        targetId,
        ...(generation !== undefined ? { generation } : {}),
      });
      return;
    }
    if (!visible) {
      onUpdate({ type: "clear", targetId, generation });
      return;
    }
    const position = measureAnchor(anchor);
    if (!position) return;
    onUpdate({ type: "show", anchor: position, targetId, generation });
  }, [anchor, generation, onUpdate, state, targetId, tick, visible]);

  useEffect(
    () => () =>
      onUpdate({ type: "clear", targetId, ...(generation !== undefined ? { generation } : {}) }),
    [generation, onUpdate, targetId],
  );
  return caretAnchor && windowFocused && !state.composing ? (
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

function measureAnchor(element: HTMLElement): ImeCandidateAnchor | undefined {
  const targetId = element.dataset.imeTargetId;
  const compositionProjection = Array.from(
    document.querySelectorAll<HTMLElement>("[data-ime-composition-target]"),
  ).find((projection) => projection.dataset.imeCompositionTarget === targetId);
  const compositionCaret = compositionProjection?.querySelector<HTMLElement>(
    "[data-ime-composition-caret='true']",
  );
  if (compositionCaret) {
    const rect = compositionCaret.getBoundingClientRect();
    if (rect.width || rect.height)
      return { x: rect.left, lineTop: rect.top, lineBottom: rect.bottom };
  }
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const caret = element.selectionStart ?? element.value.length;
    return measureInputCaret(element, caret);
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
