import type { ImeEditorCommand } from "../imeKeyRouter";

export interface TextSelectionRange {
  start: number;
  end: number;
}

export interface ControlledTextEdit {
  value: string;
  caret: number;
  selection: TextSelectionRange;
}

/** Builds one controlled-text edit without coupling the editor to IME state. */
export function replaceTextRange(
  value: string,
  range: TextSelectionRange,
  insertedText: string,
): ControlledTextEdit {
  const start = clampOffset(value, Math.min(range.start, range.end));
  const end = clampOffset(value, Math.max(range.start, range.end));
  const caret = start + insertedText.length;
  return {
    value: `${value.slice(0, start)}${insertedText}${value.slice(end)}`,
    caret,
    selection: { start: caret, end: caret },
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

export function forwardDeletionRange(value: string, range: TextSelectionRange): TextSelectionRange {
  const start = clampOffset(value, Math.min(range.start, range.end));
  const end = clampOffset(value, Math.max(range.start, range.end));
  if (start !== end || start === value.length) return { start, end };
  return { start, end: end + 1 };
}

export function applyControlledTextCommand(
  input: HTMLInputElement | HTMLTextAreaElement,
  value: string,
  command: ImeEditorCommand,
): ControlledTextEdit | undefined {
  const start = input.selectionStart ?? value.length;
  const end = input.selectionEnd ?? start;
  if (command.type === "deleteBackward" || command.type === "deleteForward") {
    const range =
      command.type === "deleteBackward"
        ? backwardDeletionRange(value, { start, end })
        : forwardDeletionRange(value, { start, end });
    return replaceTextRange(value, range, "");
  }

  let caret = start === end ? start : command.direction === "left" ? start : end;
  if (command.direction === "left") caret = Math.max(0, caret - 1);
  else if (command.direction === "right") caret = Math.min(value.length, caret + 1);
  else if (command.direction === "pageUp") caret = 0;
  else if (command.direction === "pageDown") caret = value.length;
  else if (input instanceof HTMLTextAreaElement) {
    const lineStart = value.lastIndexOf("\n", Math.max(0, caret - 1)) + 1;
    const column = caret - lineStart;
    const previousLineEnd = lineStart - 1;
    if (command.direction === "up" && previousLineEnd >= 0) {
      const previousLineStart = value.lastIndexOf("\n", Math.max(0, previousLineEnd - 1)) + 1;
      caret = Math.min(previousLineStart + column, previousLineEnd);
    } else if (command.direction === "down") {
      const nextLineStart = value.indexOf("\n", caret);
      if (nextLineStart >= 0) {
        const nextLineEnd = value.indexOf("\n", nextLineStart + 1);
        caret = Math.min(nextLineStart + 1 + column, nextLineEnd < 0 ? value.length : nextLineEnd);
      }
    }
  }

  if (command.extend) {
    input.setSelectionRange(start, caret);
    return undefined;
  }
  input.setSelectionRange(caret, caret);
  return undefined;
}

/** Applies an editor command using app-owned offsets, without reading DOM selection. */
export function applyControlledTextCommandAtSelection(
  value: string,
  selection: TextSelectionRange,
  command: ImeEditorCommand,
  multiline: boolean,
): ControlledTextEdit {
  const start = clampOffset(value, Math.min(selection.start, selection.end));
  const end = clampOffset(value, Math.max(selection.start, selection.end));
  if (command.type === "deleteBackward" || command.type === "deleteForward") {
    const range =
      command.type === "deleteBackward"
        ? backwardDeletionRange(value, { start, end })
        : forwardDeletionRange(value, { start, end });
    return replaceTextRange(value, range, "");
  }

  let caret = start === end ? start : command.direction === "left" ? start : end;
  if (command.direction === "left") caret = Math.max(0, caret - 1);
  else if (command.direction === "right") caret = Math.min(value.length, caret + 1);
  else if (command.direction === "pageUp") caret = 0;
  else if (command.direction === "pageDown") caret = value.length;
  else if (multiline) {
    const lineStart = value.lastIndexOf("\n", Math.max(0, caret - 1)) + 1;
    const column = caret - lineStart;
    const previousLineEnd = lineStart - 1;
    if (command.direction === "up" && previousLineEnd >= 0) {
      const previousLineStart = value.lastIndexOf("\n", Math.max(0, previousLineEnd - 1)) + 1;
      caret = Math.min(previousLineStart + column, previousLineEnd);
    } else if (command.direction === "down") {
      const nextLineStart = value.indexOf("\n", caret);
      if (nextLineStart >= 0) {
        const nextLineEnd = value.indexOf("\n", nextLineStart + 1);
        caret = Math.min(nextLineStart + 1 + column, nextLineEnd < 0 ? value.length : nextLineEnd);
      }
    }
  }

  return {
    value,
    caret,
    selection: command.extend ? { start, end: caret } : { start: caret, end: caret },
  };
}

function clampOffset(value: string, offset: number): number {
  return Math.max(0, Math.min(value.length, offset));
}
