import type { ImeState } from "@answra/shared";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ImeCandidatePopup } from "./ImeCandidatePopup";
import "./ImeCandidateOverlay.css";

interface ImeCandidateOverlayProps {
  state: ImeState;
  onSelect: (index: number) => void;
  onNavigate: (key: string) => void;
}

const EDGE_MARGIN = 8;
const GAP = 6;
const FALLBACK_HEIGHT = 44;
const FALLBACK_WIDTH = 260;

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

/**
 * 候选窗全局浮层：像系统输入法一样脱离面板渲染（portal 到 body），
 * 锚定在当前焦点输入框（[data-embedded-ime-target]）的组合光标处；
 * 贴近窗口底部时自动翻转到光标上方。
 */
export function ImeCandidateOverlay({ state, onSelect, onNavigate }: ImeCandidateOverlayProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [position, setPosition] = useState({ left: -9999, top: -9999 });
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick((current) => current + 1), []);

  // 用 focusin/focusout 的 target 判定锚点，比 activeElement 更直接可靠。
  const handleFocusCapture = useCallback((event: FocusEvent) => {
    if (event.type === "focusout") {
      setAnchor(null);
      return;
    }
    const target = event.target;
    setAnchor(
      target instanceof HTMLElement && target.matches("[data-embedded-ime-target]")
        ? target
        : null,
    );
  }, []);

  useEffect(() => {
    // 挂载时输入框可能已持有焦点（组合进行中），从 activeElement 补一次判定。
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.matches("[data-embedded-ime-target]")) {
      setAnchor(active);
    }
    document.addEventListener("focusin", handleFocusCapture, true);
    document.addEventListener("focusout", handleFocusCapture, true);
    window.addEventListener("resize", bump);
    return () => {
      document.removeEventListener("focusin", handleFocusCapture, true);
      document.removeEventListener("focusout", handleFocusCapture, true);
      window.removeEventListener("resize", bump);
    };
  }, [bump, handleFocusCapture]);

  useEffect(() => {
    if (!anchor) return;
    window.addEventListener("scroll", bump, true);
    return () => window.removeEventListener("scroll", bump, true);
  }, [anchor, bump]);

  const visible =
    state.enabled && anchor !== null && (state.preedit.length > 0 || state.candidates.length > 0);

  useLayoutEffect(() => {
    if (!visible || !(anchor instanceof HTMLTextAreaElement)) return;
    const caret = measureCaret(anchor);
    if (!caret) return;
    const height = containerRef.current?.offsetHeight || FALLBACK_HEIGHT;
    const width = containerRef.current?.offsetWidth || FALLBACK_WIDTH;
    let top = caret.lineBottom + GAP;
    if (top + height > window.innerHeight - EDGE_MARGIN) {
      top = Math.max(EDGE_MARGIN, caret.lineTop - height - GAP);
    }
    const left = Math.min(
      Math.max(EDGE_MARGIN, caret.x),
      Math.max(EDGE_MARGIN, window.innerWidth - width - EDGE_MARGIN),
    );
    setPosition({ left, top });
  }, [anchor, visible, tick, state.preedit, state.candidates.length, state.selectedIndex, state.page]);

  if (!visible || !anchor) return null;
  return createPortal(
    // mousedown 不改变焦点，避免点击候选按钮时焦点离开输入框导致浮层消失。
    <div
      className="ime-candidate-overlay"
      onMouseDown={(event) => event.preventDefault()}
      ref={containerRef}
      style={{ left: position.left, position: "fixed", top: position.top, zIndex: 1000 }}
    >
      <ImeCandidatePopup onNavigate={onNavigate} onSelect={onSelect} state={state} />
    </div>,
    document.body,
  );
}

/** 用镜像节点测量 textarea 中组合光标的视口坐标（系统输入法候选窗的锚定方式）。 */
function measureCaret(textarea: HTMLTextAreaElement) {
  const caret = textarea.selectionStart ?? textarea.value.length;
  const style = window.getComputedStyle(textarea);
  const mirror = document.createElement("div");
  for (const key of MIRROR_STYLE_KEYS) mirror.style[key] = style[key];
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.textContent = textarea.value.slice(0, caret);
  const marker = document.createElement("span");
  marker.textContent = textarea.value.slice(caret) || "​";
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
