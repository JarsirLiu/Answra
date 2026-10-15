import type { ImeInputMode } from "@answra/shared";

export interface ImeTextPolicyInput {
  /** Whether the current target has an accepted, focused IME lease. */
  targetOwned: boolean;
  inputMode: ImeInputMode;
  composing: boolean;
}

export interface ImeTextPolicy {
  /** Native input is allowed for ASCII mode or for a target outside the lease. */
  useNativeTextInput: boolean;
  /** Keep the native control read-only while Rime owns Chinese text input. */
  readOnly: boolean;
  /** Prevent the platform composition path only for the current lease owner. */
  blockComposition: boolean;
  /** Whether Backspace must be handled by the engine, editor adapter, or browser. */
  backspace: "engine" | "editor" | "native";
  /** Capture the selection before the first Chinese key in a new composition. */
  captureCompositionStart: boolean;
}

/**
 * Centralizes text-event routing without owning session, focus, or editor state.
 * The caller still decides how to apply the selected route to its editor.
 */
export function resolveImeTextPolicy(input: ImeTextPolicyInput): ImeTextPolicy {
  if (!input.targetOwned) {
    return {
      useNativeTextInput: true,
      readOnly: false,
      blockComposition: false,
      backspace: "native",
      captureCompositionStart: false,
    };
  }

  if (input.inputMode === "ascii") {
    return {
      useNativeTextInput: true,
      readOnly: false,
      blockComposition: true,
      backspace: "native",
      captureCompositionStart: false,
    };
  }

  return {
    useNativeTextInput: false,
    readOnly: true,
    blockComposition: true,
    backspace: input.composing ? "engine" : "editor",
    captureCompositionStart: !input.composing,
  };
}

export function shouldPreventImeBeforeInput(policy: ImeTextPolicy, inputType: string): boolean {
  return (
    !policy.useNativeTextInput ||
    (policy.blockComposition && inputType.startsWith("insertComposition"))
  );
}
