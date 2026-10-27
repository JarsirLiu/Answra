import { describe, expect, it } from "vitest";
import {
  applyControlledTextCommand,
  applyControlledTextCommandAtSelection,
  backwardDeletionRange,
  replaceTextRange,
} from "../src/ime/adapters/controlledTextAdapter";

describe("controlled text adapter", () => {
  it("replaces a selection and returns the resulting caret", () => {
    expect(replaceTextRange("hello world", { start: 6, end: 11 }, "Answra")).toEqual({
      value: "hello Answra",
      caret: 12,
      selection: { start: 12, end: 12 },
    });
  });

  it("clamps stale offsets and normalizes reversed ranges", () => {
    expect(replaceTextRange("abc", { start: 20, end: 1 }, "x")).toEqual({
      value: "ax",
      caret: 2,
      selection: { start: 2, end: 2 },
    });
  });

  it("deletes the selection or the preceding character", () => {
    expect(backwardDeletionRange("abcd", { start: 1, end: 3 })).toEqual({ start: 1, end: 3 });
    expect(backwardDeletionRange("abcd", { start: 3, end: 3 })).toEqual({ start: 2, end: 3 });
    expect(backwardDeletionRange("abcd", { start: 0, end: 0 })).toEqual({ start: 0, end: 0 });
  });

  it("applies typed deletion and caret commands against the editor selection", () => {
    const input = document.createElement("textarea");
    input.value = "abcd";
    input.setSelectionRange(1, 3);
    expect(applyControlledTextCommand(input, input.value, { type: "deleteBackward" })).toEqual({
      value: "ad",
      caret: 1,
      selection: { start: 1, end: 1 },
    });

    input.setSelectionRange(2, 2);
    expect(
      applyControlledTextCommand(input, input.value, {
        type: "moveCaret",
        direction: "right",
        extend: true,
      }),
    ).toBeUndefined();
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 3]);
  });

  it("applies the same selection command contract to a native text input", () => {
    const input = document.createElement("input");
    input.type = "text";
    input.value = "abcd";
    input.setSelectionRange(1, 3);

    expect(applyControlledTextCommand(input, input.value, { type: "deleteBackward" })).toEqual({
      value: "ad",
      caret: 1,
      selection: { start: 1, end: 1 },
    });
    input.value = "ad";
    input.setSelectionRange(1, 1);
    expect([input.selectionStart, input.selectionEnd]).toEqual([1, 1]);
  });

  it("applies editing commands from a logical selection without reading the DOM", () => {
    const result = applyControlledTextCommandAtSelection(
      "abcd",
      { start: 1, end: 3 },
      { type: "deleteBackward" },
      false,
    );
    expect(result).toEqual({
      value: "ad",
      caret: 1,
      selection: { start: 1, end: 1 },
    });

    const extended = applyControlledTextCommandAtSelection(
      "abcd",
      { start: 2, end: 2 },
      { type: "moveCaret", direction: "right", extend: true },
      false,
    );
    expect(extended).toEqual({
      value: "abcd",
      caret: 3,
      selection: { start: 2, end: 3 },
    });
  });
});
