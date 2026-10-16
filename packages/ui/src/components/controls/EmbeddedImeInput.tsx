import type { DesktopBridge } from "@answra/shared";
import { type InputHTMLAttributes, useEffect, useLayoutEffect, useRef } from "react";
import { useEmbeddedIme } from "../../hooks/useEmbeddedIme";
import { ControlledTextCompositionMirror } from "../../ime/adapters/ControlledTextCompositionMirror";
import { applyControlledTextCommand } from "../../ime/adapters/controlledTextAdapter";
import { useControlledImeTextAdapter } from "../../ime/adapters/useControlledImeTextAdapter";
import { handleImeEditorKeyDown, imeEditorAttributes } from "../../ime/imeEditorBinding";
import { resolveImeEditorInputState } from "../../ime/imeTextPolicy";
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
  const inputState = resolveImeEditorInputState({
    businessReadOnly: Boolean(props.readOnly),
    policy: textPolicy,
  });
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
        blockNativeEditing={textPolicy.blockNativeEditing}
        generation={ime.generation}
        onUpdate={ime.updateCandidate}
        state={ime.state}
        targetId={targetId}
      />
      <input
        {...props}
        {...imeEditorAttributes({ targetId, composing: ime.state.composing })}
        className={`${props.className ?? ""} embedded-ime-input${ime.state.composing ? " ime-composition-active" : ""}`.trim()}
        aria-readonly={inputState.ariaReadOnly}
        data-ime-native-input-blocked={inputState.nativeInputBlockedByIme ? "true" : undefined}
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
          const handled = handleImeEditorKeyDown({
            event,
            policy: textPolicy,
            readSelection: () => ({
              start: event.currentTarget.selectionStart ?? value.length,
              end: event.currentTarget.selectionEnd ?? value.length,
            }),
            onCaptureCompositionStart: (range) =>
              controlledText.captureCompositionStart(range, ime.state.composing),
            sendKey: (keyEvent, apply) => ime.sendKey(keyEvent, false, apply),
            applyEditorCommand,
          });
          if (handled) {
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
        readOnly={inputState.readOnly}
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
