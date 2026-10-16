import type { DesktopBridge } from "@answra/shared";
import { type InputHTMLAttributes, useEffect, useLayoutEffect, useRef } from "react";
import { useEmbeddedIme } from "../../hooks/useEmbeddedIme";
import { ControlledTextCompositionMirror } from "../../ime/adapters/ControlledTextCompositionMirror";
import { applyControlledTextCommand } from "../../ime/adapters/controlledTextAdapter";
import { useControlledImeTextAdapter } from "../../ime/adapters/useControlledImeTextAdapter";
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
  const controlledText = useControlledImeTextAdapter({
    inputRef,
    value,
    onChange: onValueChange,
  });
  const pendingCaret = useRef<number | null>(null);
  const ime = useEmbeddedIme(bridge, controlledText.commit, true, targetId);
  const textPolicy = ime.textPolicy;
  useEffect(() => {
    if (!ime.state.composing) controlledText.cancelComposition();
  }, [controlledText.cancelComposition, ime.state.composing]);

  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    const input = inputRef.current;
    if (caret === null || !input) return;
    input.setSelectionRange(caret, caret);
    pendingCaret.current = null;
  });

  const applyEditorCommand = (command: Parameters<typeof applyControlledTextCommand>[2]) => {
    const input = inputRef.current;
    if (!input) return;
    const edit = applyControlledTextCommand(input, value, command);
    if (!edit) return;
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
        className={`${props.className ?? ""} embedded-ime-input${ime.state.composing ? " ime-composition-active" : ""}`.trim()}
        aria-readonly={textPolicy.blockNativeEditing || props.readOnly || undefined}
        data-embedded-ime-target="true"
        data-ime-composition-active={ime.state.composing ? "true" : undefined}
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
          if (
            textPolicy.captureCompositionStart &&
            (event.key.length === 1 || event.key === "Process") &&
            !event.ctrlKey &&
            !event.altKey &&
            !event.metaKey
          ) {
            controlledText.captureCompositionStart(
              {
                start: event.currentTarget.selectionStart ?? value.length,
                end: event.currentTarget.selectionEnd ?? value.length,
              },
              ime.state.composing,
            );
          }
          if (ime.sendKey(event, false, applyEditorCommand)) {
            event.preventDefault();
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
        readOnly={textPolicy.blockNativeEditing || props.readOnly}
        ref={inputRef}
        type={type}
        value={value}
        onChange={(event) => {
          if (textPolicy.useNativeTextInput) onValueChange(event.currentTarget.value);
        }}
      />
      {ime.state.composing && ime.state.preedit && controlledText.compositionRange && (
        <ControlledTextCompositionMirror
          inputRef={inputRef}
          preedit={ime.state.preedit}
          range={controlledText.compositionRange}
          targetId={targetId}
          value={value}
        />
      )}
    </>
  );
}
