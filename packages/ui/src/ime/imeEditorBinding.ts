import type { ImeEditorCommand } from "./imeKeyRouter";
import type { ImeTextPolicy } from "./imeTextPolicy";

/** The key fields every surface exposes, whatever the event transport (React or DOM). */
export interface ImeEditorKeyEvent {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export interface ImeSelectionRange {
  start: number;
  end: number;
}

export interface ImeEditorKeyDownArgs<Event extends ImeEditorKeyEvent> {
  event: Event;
  policy: ImeTextPolicy;
  /** Reads the live caret from the host element at key time. */
  readSelection: () => ImeSelectionRange;
  /** Receives the caret captured for the first key of a new composition. */
  onCaptureCompositionStart: (range: ImeSelectionRange) => void;
  /** Routes the key to the engine; returns true when the key was handled. */
  sendKey: (event: Event, applyEditorCommand: (command: ImeEditorCommand) => void) => boolean;
  applyEditorCommand: (command: ImeEditorCommand) => void;
}

/**
 * Shared keydown wiring for every embedded-IME surface: capture the caret before the
 * first Chinese key of a new composition, then hand the key to the engine. Returns
 * whether the key was handled, so the caller knows to call `preventDefault`.
 *
 * Lives outside React because the DOM transport differs per surface (React synthetic
 * events for `<input>`/`<textarea>`, raw `KeyboardEvent` for CodeMirror); only the
 * decision is shared, never the event object.
 */
export function handleImeEditorKeyDown<Event extends ImeEditorKeyEvent>(
  args: ImeEditorKeyDownArgs<Event>,
): boolean {
  if (args.policy.captureCompositionStart && isImeCompositionStartKey(args.event))
    args.onCaptureCompositionStart(args.readSelection());
  return args.sendKey(args.event, args.applyEditorCommand);
}

/** A composition can only begin on a single printable key (or Windows "Process"). */
export function isImeCompositionStartKey(event: ImeEditorKeyEvent): boolean {
  return (
    (event.key.length === 1 || event.key === "Process") &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey
  );
}

export interface ImeEditorAttributeInput {
  targetId: string;
  /** Editor currently owns the session; enables `data-embedded-ime-active`. */
  active?: boolean;
  composing?: boolean;
}

/**
 * The `data-*` markers every embedded-IME surface must publish so the candidate anchor
 * reporter and capture logic can find the target. React surfaces spread this on the
 * element; CodeMirror feeds the same map to `EditorView.contentAttributes`.
 */
export function imeEditorAttributes(input: ImeEditorAttributeInput): Record<string, string> {
  const attributes: Record<string, string> = {
    "data-embedded-ime-target": "true",
    "data-ime-policy": "text",
    "data-ime-target-id": input.targetId,
  };
  if (input.active) attributes["data-embedded-ime-active"] = "true";
  if (input.composing) attributes["data-ime-composition-active"] = "true";
  return attributes;
}
