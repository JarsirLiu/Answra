import { describe, expect, it } from "vitest";
import {
  endOfLineOffset,
  layoutInput,
  moveCursorVertically,
  nextGraphemeOffset,
  previousGraphemeOffset,
  previousWordOffset,
  startOfLineOffset,
} from "../src/tui/components/inputLayout";

describe("input layout", () => {
  it("keeps wide characters and emoji on the right column", () => {
    const layout = layoutInput("中文🙂a", 2, 4, 3);
    expect(layout.cursorLine).toBe(1);
    expect(layout.cursorColumn).toBe(0);
    expect(layout.lines[0]?.width).toBe(4);
  });

  it("wraps long input and keeps the cursor visible", () => {
    const layout = layoutInput("abcdef", 6, 2, 2);
    expect(layout.lines.map((line) => line.tokens.map((token) => token.text).join(""))).toEqual([
      "ab",
      "cd",
      "ef",
    ]);
    expect(layout.cursorLine).toBe(2);
    expect(layout.cursorColumn).toBe(2);
    expect(layout.startLine).toBe(1);
    expect(layout.hiddenAbove).toBe(1);
  });

  it("treats a newline as a hard line break", () => {
    const layout = layoutInput("a\nb", 2, 80, 3);
    expect(layout.cursorLine).toBe(1);
    expect(layout.cursorColumn).toBe(0);
  });

  it("moves by grapheme instead of UTF-16 code unit", () => {
    expect(previousGraphemeOffset("🙂a", 3)).toBe(2);
    expect(nextGraphemeOffset("🙂a", 0)).toBe(2);
    expect(previousWordOffset("hello world", 11)).toBe(5);
  });

  it("moves vertically by display line and keeps the display column", () => {
    expect(moveCursorVertically("abcdef", 6, 2, -1)).toBe(4);
    expect(moveCursorVertically("abcdef", 4, 2, -1)).toBe(2);
    expect(moveCursorVertically("abcdef", 2, 2, 1)).toBe(4);
  });

  it("clamps vertical movement to a shorter line", () => {
    expect(moveCursorVertically("xy\nabcdef", 8, 80, -1)).toBe(2);
    expect(moveCursorVertically("xy\nabcdef", 2, 80, 1)).toBe(5);
  });

  it("returns undefined when no vertical neighbour exists", () => {
    expect(moveCursorVertically("abcdef", 0, 2, -1)).toBeUndefined();
    expect(moveCursorVertically("abcdef", 6, 2, 1)).toBeUndefined();
    expect(moveCursorVertically("", 0, 80, -1)).toBeUndefined();
  });

  it("treats Home and End as visual line boundaries", () => {
    expect(startOfLineOffset("abcdef", 5, 2)).toBe(4);
    expect(startOfLineOffset("abcdef", 4, 2)).toBe(2);
    expect(startOfLineOffset("a\nb", 2, 80)).toBe(0);
    expect(endOfLineOffset("abcdef", 5, 2)).toBe(6);
    expect(endOfLineOffset("ab\ncd", 0, 80)).toBe(2);
  });

  it("keeps wide characters on grapheme boundaries when moving horizontally", () => {
    expect(moveCursorVertically("中文\nab", 5, 80, -1)).toBe(1);
    expect(startOfLineOffset("中文中文", 2, 2)).toBe(1);
  });
});
