export interface ImeTextPolicyInput {
  /** Whether the current target has an accepted, focused IME lease. */
  targetOwned: boolean;
  composing: boolean;
}

export interface ImeTextPolicy {
  /**
   * Native input is allowed only for a target outside the lease. Keeping the
   * editor read-only for every owned target stops Chromium from offering the
   * focused element to the platform IME (Windows TSF) in ASCII mode too.
   */
  useNativeTextInput: boolean;
  /** Block direct browser mutations; editor adapter commands remain writable. */
  blockNativeEditing: boolean;
  /** Prevent the platform composition path only for the current lease owner. */
  blockComposition: boolean;
  /** Capture the selection before the first Chinese key in a new composition. */
  captureCompositionStart: boolean;
}

/**
 * Centralizes text-event routing without owning session, focus, or editor state.
 * Key-by-key routing (including Backspace) belongs to the key router; this policy
 * only decides whether native text events are routed to the engine or the editor.
 */
export function resolveImeTextPolicy(input: ImeTextPolicyInput): ImeTextPolicy {
  if (!input.targetOwned) {
    return {
      useNativeTextInput: true,
      blockNativeEditing: false,
      blockComposition: false,
      captureCompositionStart: false,
    };
  }

  return {
    useNativeTextInput: false,
    blockNativeEditing: true,
    blockComposition: true,
    captureCompositionStart: !input.composing,
  };
}

export function shouldPreventImeBeforeInput(policy: ImeTextPolicy, inputType: string): boolean {
  return (
    !policy.useNativeTextInput ||
    (policy.blockComposition && inputType.startsWith("insertComposition"))
  );
}
