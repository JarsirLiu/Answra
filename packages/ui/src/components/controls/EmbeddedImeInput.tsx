import type { DesktopBridge } from "@answra/shared";
import { type InputHTMLAttributes, useCallback, useLayoutEffect, useRef } from "react";
import { useEmbeddedIme } from "../../hooks/useEmbeddedIme";
import { ImeCandidateAnchorReporter } from "../panels/ImeCandidateAnchorReporter";

interface EmbeddedImeInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "type"> {
  bridge?: DesktopBridge;
  targetId: string;
  value: string;
  onValueChange: (value: string) => void;
  type?: "text" | "search" | "url";
}

/** Controlled free-text input backed by the shared Rime session. */
export function EmbeddedImeInput({
  bridge,
  targetId,
  value,
  onValueChange,
  type = "text",
  ...props
}: EmbeddedImeInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const commit = useCallback(
    (text: string) => {
      const input = inputRef.current;
      const start = input?.selectionStart ?? value.length;
      const end = input?.selectionEnd ?? start;
      pendingCaret.current = start + text.length;
      onValueChange(`${value.slice(0, start)}${text}${value.slice(end)}`);
    },
    [onValueChange, value],
  );
  const ime = useEmbeddedIme(bridge, commit, true, targetId);

  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    const input = inputRef.current;
    if (caret === null || !input) return;
    input.setSelectionRange(caret, caret);
    pendingCaret.current = null;
  });

  const replaceSelection = (text: string) => {
    const input = inputRef.current;
    if (!input) return;
    const start = input.selectionStart ?? value.length;
    const end = input.selectionEnd ?? start;
    const from = text ? start : start === end ? Math.max(0, start - 1) : start;
    const to = text ? end : end;
    pendingCaret.current = from + text.length;
    onValueChange(`${value.slice(0, from)}${text}${value.slice(to)}`);
  };

  return (
    <>
      <ImeCandidateAnchorReporter
        generation={ime.generation}
        onUpdate={ime.updateCandidate}
        state={ime.state}
        targetId={targetId}
      />
      <input
        {...props}
        aria-readonly={(ime.active && !ime.asciiMode) || undefined}
        data-embedded-ime-target="true"
        data-ime-policy="text"
        data-ime-target-id={targetId}
        onBeforeInput={(event) => {
          props.onBeforeInput?.(event);
          if (ime.active && !ime.asciiMode) event.preventDefault();
        }}
        onBlur={() => ime.blur()}
        onCompositionStart={(event) => {
          props.onCompositionStart?.(event);
          if (ime.active && !ime.asciiMode) event.preventDefault();
        }}
        onFocus={() => void ime.acquire()}
        onKeyDown={(event) => {
          if (ime.sendKey(event)) {
            event.preventDefault();
            return;
          }
          if (ime.active && !ime.asciiMode && !ime.state.composing && event.key === "Backspace") {
            event.preventDefault();
            replaceSelection("");
            return;
          }
          props.onKeyDown?.(event);
        }}
        onKeyUp={(event) => {
          if (ime.sendKeyUp(event)) {
            event.preventDefault();
            return;
          }
          props.onKeyUp?.(event);
        }}
        readOnly={(ime.active && !ime.asciiMode) || props.readOnly}
        ref={inputRef}
        type={type}
        value={value}
        onChange={(event) => {
          if (!ime.active || ime.asciiMode) onValueChange(event.currentTarget.value);
        }}
      />
    </>
  );
}
