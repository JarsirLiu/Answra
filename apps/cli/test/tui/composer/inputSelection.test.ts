import { describe, expect, it } from "vitest";
import { deleteSelection, selectedText, selectionRange } from "../../../src/tui/composer/selection";

describe("input selection", () => {
  it("normalizes the anchor and cursor into an ordered range", () => {
    expect(selectionRange(null, 3)).toBeUndefined();
    expect(selectionRange(3, 3)).toBeUndefined();
    expect(selectionRange(2, 5)).toEqual({ start: 2, end: 5 });
    expect(selectionRange(5, 2)).toEqual({ start: 2, end: 5 });
  });

  it("extracts the selected text", () => {
    expect(selectedText("hello world", { start: 6, end: 11 })).toBe("world");
  });

  it("removes the selection and puts the cursor at its start", () => {
    expect(deleteSelection("hello world", { start: 5, end: 11 })).toEqual({
      value: "hello",
      cursor: 5,
    });
  });
});
