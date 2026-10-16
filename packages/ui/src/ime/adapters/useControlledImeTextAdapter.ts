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
  const pendingCaretRef = useRef<number | null>(null);
  valueRef.current = value;
  onChangeRef.current = onChange;

  useLayoutEffect(() => {
    const caret = pendingCaretRef.current;
    const input = inputRef.current;
    if (caret === null || !input) return;
    input.setSelectionRange(caret, caret);
    pendingCaretRef.current = null;
  });

  const captureCompositionStart = useCallback(
    (range: TextSelectionRange, compositionActive: boolean) => {
      if (!compositionActive) {
        compositionSelectionRef.current = range;
        setCompositionRange(range);
      }
    },
    [],
  );

  const commit = useCallback(
    (text: string) => {
      const input = inputRef.current;
      const range = compositionSelectionRef.current;
      const start = range?.start ?? input?.selectionStart ?? valueRef.current.length;
      const end = range?.end ?? input?.selectionEnd ?? start;
      compositionSelectionRef.current = null;
      setCompositionRange(null);
      const edit = replaceTextRange(valueRef.current, { start, end }, text);
      pendingCaretRef.current = edit.caret;
      valueRef.current = edit.value;
      onChangeRef.current(edit.value);
    },
    [inputRef],
  );

  const cancelComposition = useCallback(() => {
    compositionSelectionRef.current = null;
    setCompositionRange(null);
  }, []);

  return { captureCompositionStart, commit, cancelComposition, compositionRange };
}
