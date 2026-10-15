import type { DesktopBridge } from "@answra/shared";
import { type InputHTMLAttributes, useCallback, useLayoutEffect, useRef } from "react";
import { useEmbeddedIme } from "../../hooks/useEmbeddedIme";
import { backwardDeletionRange, replaceTextRange } from "../../ime/adapters/controlledTextAdapter";
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
      const edit = replaceTextRange(value, { start, end }, text);
      pendingCaret.current = edit.caret;
      onValueChange(edit.value);
    },
    [onValueChange, value],
  );
  const ime = useEmbeddedIme(bridge, commit, true, targetId);
  const textPolicy = ime.textPolicy;

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
    const range = text ? { start, end } : backwardDeletionRange(value, { start, end });
    const edit = replaceTextRange(value, range, text);
    pendingCaret.current = edit.caret;
    onValueChange(edit.value);
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
        aria-readonly={textPolicy.readOnly || props.readOnly || undefined}
        data-embedded-ime-target="true"
        data-ime-policy="text"
        data-ime-target-id={targetId}
        onBeforeInput={(event) => {
          props.onBeforeInput?.(event);
          if (ime.shouldPreventBeforeInput(event.nativeEvent.inputType)) event.preventDefault();
        }}
        onBlur={() => ime.blur()}
        onCompositionStart={(event) => {
          props.onCompositionStart?.(event);
          if (textPolicy.blockComposition) event.preventDefault();
        }}
        onFocus={() => void ime.acquire()}
        onKeyDown={(event) => {
          if (ime.sendKey(event)) {
            event.preventDefault();
            return;
          }
          if (textPolicy.backspace === "editor" && event.key === "Backspace") {
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
        readOnly={textPolicy.readOnly || props.readOnly}
        ref={inputRef}
        type={type}
        value={value}
        onChange={(event) => {
          if (textPolicy.useNativeTextInput) onValueChange(event.currentTarget.value);
        }}
      />
    </>
  );
}
