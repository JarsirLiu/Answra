import { describe, expect, it } from "vitest";
import {
  compareSelectionPoints,
  extractSelectionText,
  highlightSelection,
  orderSelection,
  type RenderedLine,
  selectAllBounds,
  selectionRowRange,
  sliceByColumns,
  stripAnsi,
} from "../../../src/tui/interaction/selection";

const line = (row: number, left: number, text: string): RenderedLine => ({ row, left, text });

describe("selection", () => {
  it("orders anchor and focus in reading order", () => {
    expect(orderSelection({ row: 2, col: 3 }, { row: 1, col: 4 })).toEqual({
      start: { row: 1, col: 4 },
      end: { row: 2, col: 3 },
    });
    expect(orderSelection({ row: 1, col: 1 }, { row: 1, col: 1 })).toBeUndefined();
    expect(orderSelection(undefined, { row: 1, col: 1 })).toBeUndefined();
    expect(compareSelectionPoints({ row: 1, col: 2 }, { row: 1, col: 10 })).toBeLessThan(0);
  });

  it("clips a selection to the rendered columns of a line", () => {
    const bounds = orderSelection({ row: 0, col: 0 }, { row: 2, col: 99 });
    if (bounds === undefined) throw new Error("bounds expected");
    expect(selectionRowRange(bounds, line(1, 2, "hello"))).toEqual({ from: 0, to: 4 });

    const partial = orderSelection({ row: 1, col: 4 }, { row: 1, col: 6 });
    if (partial === undefined) throw new Error("bounds expected");
    expect(selectionRowRange(partial, line(1, 2, "hello"))).toEqual({ from: 2, to: 4 });
  });

  it("extracts whole middle lines and clips the first and last", () => {
    const bounds = orderSelection({ row: 0, col: 2 }, { row: 2, col: 2 });
    if (bounds === undefined) throw new Error("bounds expected");
    const lines = new Map([
      [0, line(0, 0, "alpha")],
      [1, line(1, 0, "beta")],
      [2, line(2, 0, "gamma")],
    ]);
    expect(extractSelectionText(bounds, lines)).toBe("pha\nbeta\ngam");
  });

  it("trims trailing whitespace and leading/trailing blank lines", () => {
    const bounds = orderSelection({ row: 0, col: 0 }, { row: 2, col: 99 });
    if (bounds === undefined) throw new Error("bounds expected");
    const lines = new Map([
      [0, line(0, 0, "   ")],
      [1, line(1, 0, "hello   ")],
      [2, line(2, 0, "")],
    ]);
    expect(extractSelectionText(bounds, lines)).toBe("hello");
  });

  it("snaps column slicing to grapheme boundaries for wide characters", () => {
    expect(sliceByColumns("中文ab", 0, 3)).toBe("中文");
    expect(sliceByColumns("中文ab", 1, 2)).toBe("中文");
    expect(sliceByColumns("中文ab", 4, 5)).toBe("ab");
  });

  it("adds inverse video only over selected columns and preserves ANSI color", () => {
    expect(highlightSelection("hello", 1, 3)).toBe("h\x1b[7mell\x1b[27mo");
    const colored = highlightSelection("\x1b[31mab\x1b[0mcd", 0, 1);
    expect(colored).toContain("\x1b[31m");
    expect(colored).toContain("\x1b[7m");
    expect(colored).toContain("\x1b[0m\x1b[7m");
    expect(stripAnsi(colored)).toBe("abcd");
  });

  it("selects all registered rows including their left offsets", () => {
    const bounds = selectAllBounds(
      new Map([
        [3, line(3, 2, "hello")],
        [1, line(1, 4, "xy")],
      ]),
    );
    expect(bounds).toEqual({
      start: { row: 1, col: 4 },
      end: { row: 3, col: 6 },
    });
    expect(selectAllBounds(new Map())).toBeUndefined();
  });
});
