import type { DesktopBridge, ImeKeyboardInput } from "@answra/shared";
import { type InputHTMLAttributes, useCallback, useEffect, useRef } from "react";
import { useEmbeddedIme } from "../../hooks/useEmbeddedIme";
import { ControlledTextCompositionMirror } from "../../ime/adapters/ControlledTextCompositionMirror";
import {
  applyControlledTextCommandAtSelection,
  replaceTextRange,
} from "../../ime/adapters/controlledTextAdapter";
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
  /** Only stealth may hand keys to embedded Rime; normal mode uses the system IME. */
  enabled: boolean;
}

/** Controlled free-text input backed by the shared Rime session. */
export function EmbeddedImeInput({
  bridge,
  targetId,
  value,
  onValueChange,
  type = "text",
  enabled,
  ...props
}: EmbeddedImeInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const controlledText = useControlledImeTextAdapter({
    inputRef,
    value,
    onChange: onValueChange,
  });
  const ime = useEmbeddedIme(bridge, controlledText.commit, enabled, targetId);
  const textPolicy = ime.textPolicy;
  const inputState = resolveImeEditorInputState({
    businessReadOnly: Boolean(props.readOnly),
    policy: textPolicy,
  });
  useEffect(() => {
    if (!ime.state.composing) controlledText.cancelComposition();
  }, [controlledText.cancelComposition, ime.state.composing]);

  const applyEditorCommand = useCallback(
    (command: Parameters<typeof applyControlledTextCommandAtSelection>[2]) => {
    const edit = applyControlledTextCommandAtSelection(
      value,
      controlledText.selection,
      command,
      false,
    );
    controlledText.setSelection(edit.selection);
    onValueChange(edit.value);
    },
    [controlledText, value, onValueChange],
  );

  useEffect(() => {
    if (!enabled) return;
    const handleNativeKey = (input: ImeKeyboardInput) => {
      ime.sendNativeKey(input, applyEditorCommand, () =>
        controlledText.captureCompositionStart(controlledText.selection, ime.state.composing),
      );
    };
    ime.setNativeKeyHandler(handleNativeKey);
    return () => ime.setNativeKeyHandler(undefined);
  }, [applyEditorCommand, enabled, ime]);

  return (
    <>
      <ImeCandidateAnchorReporter
        blockNativeEditing={textPolicy.blockNativeEditing}
        generation={ime.generation}
        onUpdate={ime.updateCandidate}
        showCaretWithoutFocus={enabled}
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
        onBlur={enabled ? undefined : () => ime.blur()}
        onCompositionStart={(event) => {
          props.onCompositionStart?.(event);
          if (textPolicy.blockComposition) event.preventDefault();
        }}
        onFocus={enabled ? undefined : () => void ime.acquire()}
        onPointerDown={(event) => {
          if (enabled) event.preventDefault();
          void ime.acquire();
        }}
        tabIndex={enabled ? -1 : props.tabIndex}
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
        onPaste={(event) => {
          props.onPaste?.(event);
          if (event.defaultPrevented || !textPolicy.blockNativeEditing) return;
          event.preventDefault();
          if (inputState.ariaReadOnly) return;
          const text = event.clipboardData.getData("text/plain");
          if (!text) return;
          const edit = replaceTextRange(
            value,
            {
              start: controlledText.selection.start,
              end: controlledText.selection.end,
            },
            text,
          );
          controlledText.setSelection(edit.selection);
          onValueChange(edit.value);
        }}
        onSelect={(event) => {
          controlledText.setSelection({
            start: event.currentTarget.selectionStart ?? value.length,
            end: event.currentTarget.selectionEnd ?? value.length,
          });
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
