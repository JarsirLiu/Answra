import { type RefObject, useCallback, useLayoutEffect, useRef, useState } from "react";
import type { TextSelectionRange } from "./controlledTextAdapter";
import { replaceTextRange } from "./controlledTextAdapter";

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
  // The DOM selection is only a rendering projection. Seed it once so the first
  // non-activating candidate measurement uses the app-owned caret too.
  const pendingSelectionRef = useRef<TextSelectionRange | null>(selectionRef.current);
  valueRef.current = value;
  onChangeRef.current = onChange;

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
      const nextSelection = { start: edit.caret, end: edit.caret };
      selectionRef.current = nextSelection;
      pendingSelectionRef.current = nextSelection;
      setSelectionState(nextSelection);
      valueRef.current = edit.value;
      onChangeRef.current(edit.value);
  }, []);

  const cancelComposition = useCallback(() => {
    compositionSelectionRef.current = null;
    setCompositionRange(null);
  }, []);

  return {
    captureCompositionStart,
    commit,
    cancelComposition,
    compositionRange,
    selection,
    setSelection,
  };
}

function clampOffset(value: string, offset: number): number {
  return Math.max(0, Math.min(value.length, offset));
}
