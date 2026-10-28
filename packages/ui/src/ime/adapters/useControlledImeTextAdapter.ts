import { type RefObject, useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  applyControlledTextCommandAtSelection,
  replaceTextRange,
  type ControlledTextEdit,
  type TextSelectionRange,
} from "./controlledTextAdapter";

interface UseControlledImeTextAdapterOptions {
  inputRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  value: string;
  onChange: (value: string) => void;
}

/** Owns the composition selection and commit caret for a controlled textarea. */
export function useControlledImeTextAdapter({
  inputRef,
  value,
  onChange,
}: UseControlledImeTextAdapterOptions) {
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const compositionSelectionRef = useRef<TextSelectionRange | null>(null);
  const [compositionRange, setCompositionRange] = useState<TextSelectionRange | null>(null);
  const selectionRef = useRef<TextSelectionRange>({ start: value.length, end: value.length });
  const [selection, setSelectionState] = useState(selectionRef.current);
  const lastObservedValueRef = useRef(value);
  const lastLocallyWrittenValueRef = useRef(value);
  // The DOM selection is only a rendering projection. Seed it once so the first
  // non-activating candidate measurement uses the app-owned caret too.
  const pendingSelectionRef = useRef<TextSelectionRange | null>(selectionRef.current);
  valueRef.current = value;
  onChangeRef.current = onChange;

  // A controlled parent can replace the value without a DOM focus event (for
  // example after submit, restore, or an external reset). In that case there is
  // no trustworthy browser caret to preserve; place the logical caret at the end.
  // Local IME commits mark their value before notifying the parent and therefore
  // keep the caret computed by the edit operation.
  useLayoutEffect(() => {
    if (
      value !== lastObservedValueRef.current &&
      value !== lastLocallyWrittenValueRef.current &&
      compositionSelectionRef.current === null
    ) {
      const next = { start: value.length, end: value.length };
      selectionRef.current = next;
      pendingSelectionRef.current = next;
      setSelectionState(next);
    }
    lastObservedValueRef.current = value;
  }, [value]);

  useLayoutEffect(() => {
    const pendingSelection = pendingSelectionRef.current;
    const input = inputRef.current;
    if (!pendingSelection || !input) return;
    input.setSelectionRange(pendingSelection.start, pendingSelection.end);
    pendingSelectionRef.current = null;
  });

  const setSelection = useCallback((range: TextSelectionRange) => {
    const next = {
      start: clampOffset(valueRef.current, Math.min(range.start, range.end)),
      end: clampOffset(valueRef.current, Math.max(range.start, range.end)),
    };
    selectionRef.current = next;
    pendingSelectionRef.current = next;
    setSelectionState(next);
  }, []);

  const captureCompositionStart = useCallback(
    (range: TextSelectionRange, compositionActive: boolean) => {
      if (!compositionActive) {
        const captured = {
          start: clampOffset(valueRef.current, Math.min(range.start, range.end)),
          end: clampOffset(valueRef.current, Math.max(range.start, range.end)),
        };
        selectionRef.current = captured;
        setSelectionState(captured);
        compositionSelectionRef.current = captured;
        setCompositionRange(captured);
      }
    },
    [],
  );

  const commit = useCallback((text: string) => {
    const range = compositionSelectionRef.current ?? selectionRef.current;
    compositionSelectionRef.current = null;
    setCompositionRange(null);
    const edit = replaceTextRange(valueRef.current, range, text);
    applyEdit(edit);
  }, []);

  const insertText = useCallback((text: string) => {
    const edit = replaceTextRange(valueRef.current, selectionRef.current, text);
    applyEdit(edit);
  }, []);

  const applyCommand = useCallback(
    (command: Parameters<typeof applyControlledTextCommandAtSelection>[2], multiline: boolean) => {
      const edit = applyControlledTextCommandAtSelection(
        valueRef.current,
        selectionRef.current,
        command,
        multiline,
      );
      applyEdit(edit);
    },
    [],
  );

  function applyEdit(edit: ControlledTextEdit): void {
    const nextSelection = edit.selection;
    selectionRef.current = nextSelection;
    pendingSelectionRef.current = nextSelection;
    setSelectionState(nextSelection);
    valueRef.current = edit.value;
    lastLocallyWrittenValueRef.current = edit.value;
    onChangeRef.current(edit.value);
  }

  const cancelComposition = useCallback(() => {
    compositionSelectionRef.current = null;
    setCompositionRange(null);
  }, []);

  return {
    captureCompositionStart,
    commit,
    insertText,
    applyCommand,
    cancelComposition,
    compositionRange,
    selection,
    setSelection,
  };
}

function clampOffset(value: string, offset: number): number {
  return Math.max(0, Math.min(value.length, offset));
}
