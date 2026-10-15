export interface TextSelectionRange {
  start: number;
  end: number;
}

export interface ControlledTextEdit {
  value: string;
  caret: number;
}

/** Builds one controlled-text edit without coupling the editor to IME state. */
export function replaceTextRange(
  value: string,
  range: TextSelectionRange,
  insertedText: string,
): ControlledTextEdit {
  const start = clampOffset(value, Math.min(range.start, range.end));
  const end = clampOffset(value, Math.max(range.start, range.end));
  return {
    value: `${value.slice(0, start)}${insertedText}${value.slice(end)}`,
    caret: start + insertedText.length,
  };
}

export function backwardDeletionRange(
  value: string,
  range: TextSelectionRange,
): TextSelectionRange {
  const start = clampOffset(value, Math.min(range.start, range.end));
  const end = clampOffset(value, Math.max(range.start, range.end));
  if (start !== end || start === 0) return { start, end };
  return { start: start - 1, end };
}

function clampOffset(value: string, offset: number): number {
  return Math.max(0, Math.min(value.length, offset));
}
