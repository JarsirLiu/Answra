import { describe, expect, it } from "vitest";
import {
  layoutInput,
  nextGraphemeOffset,
  previousGraphemeOffset,
  previousWordOffset,
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
});
