import type { CSSProperties, RefObject } from "react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { TextSelectionRange } from "./controlledTextAdapter";
import "./ControlledTextCompositionMirror.css";

type TextControl = HTMLInputElement | HTMLTextAreaElement;

interface ControlledTextCompositionMirrorProps {
  inputRef: RefObject<TextControl | null>;
  preedit: string;
  range: TextSelectionRange;
  targetId: string;
  value: string;
}

/** Draws an inline composition projection without changing the controlled value. */
export function ControlledTextCompositionMirror({
  inputRef,
  preedit,
  range,
  targetId,
  value,
}: ControlledTextCompositionMirrorProps) {
  const [layout, setLayout] = useState<CSSProperties | null>(null);
  const [scroll, setScroll] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const sync = () => {
      const rect = input.getBoundingClientRect();
      const computed = window.getComputedStyle(input);
      const compositionColor =
        computed.getPropertyValue("--ime-composition-text-color").trim() || computed.color;
      const next: CSSProperties = {
        position: "fixed",
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        overflow: "hidden",
        pointerEvents: "none",
        zIndex: 10000,
        boxSizing: computed.boxSizing as CSSProperties["boxSizing"],
        borderRadius: computed.borderRadius,
        borderColor: "transparent",
        borderStyle: computed.borderStyle,
        borderWidth: computed.borderWidth,
        color: compositionColor,
        direction: computed.direction as CSSProperties["direction"],
        fontFamily: computed.fontFamily,
        fontSize: computed.fontSize,
        fontStyle: computed.fontStyle,
        fontWeight: computed.fontWeight,
        letterSpacing: computed.letterSpacing,
        lineHeight: computed.lineHeight,
        padding: computed.padding,
        tabSize: computed.tabSize,
        textAlign: computed.textAlign as CSSProperties["textAlign"],
        textIndent: computed.textIndent,
        textTransform: computed.textTransform,
        wordBreak: computed.wordBreak as CSSProperties["wordBreak"],
        wordSpacing: computed.wordSpacing,
        whiteSpace: input instanceof HTMLTextAreaElement ? "pre-wrap" : "pre",
        overflowWrap: (input instanceof HTMLTextAreaElement
          ? "break-word"
          : "normal") as CSSProperties["overflowWrap"],
      };
      setLayout(next);
      setScroll({ x: input.scrollLeft, y: input.scrollTop });
    };
    sync();
    input.addEventListener("scroll", sync);
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    observer?.observe(input);
    return () => {
      input.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
      observer?.disconnect();
    };
  }, [inputRef]);

  if (!layout || typeof document === "undefined") return null;
  const start = Math.min(Math.max(0, Math.min(range.start, range.end)), value.length);
  const end = Math.min(Math.max(start, Math.max(range.start, range.end)), value.length);
  return createPortal(
    <div
      aria-hidden="true"
      className="ime-composition-mirror"
      data-ime-composition-projection="true"
      data-ime-composition-target={targetId}
      style={layout}
    >
      <div
        className="ime-composition-mirror-content"
        style={{ transform: `translate(${-scroll.x}px, ${-scroll.y}px)` }}
      >
        {value.slice(0, start)}
        <span className="ime-composition-preedit" data-ime-composition-preedit="true">
          {preedit}
        </span>
        <span className="ime-composition-caret" data-ime-composition-caret="true" />
        {value.slice(end)}
      </div>
    </div>,
    document.body,
  );
}
