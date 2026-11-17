import { describe, expect, it, vi } from "vitest";
import type { RenderedLine } from "../../../src/tui/interaction/selection";
import { TuiSelectionStore } from "../../../src/tui/interaction/selectionStore";

const line = (row: number, left: number, text: string): RenderedLine => ({ row, left, text });

function createStore(...lines: RenderedLine[]): TuiSelectionStore {
  const store = new TuiSelectionStore();
  for (const value of lines) store.registerLine(value);
  store.commitFrame();
  return store;
}

describe("TuiSelectionStore", () => {
  it("only exposes lines from a committed frame", () => {
    const store = new TuiSelectionStore();
    store.registerLine(line(0, 0, "hello"));
    expect(store.hasLine(0)).toBe(false);

    store.commitFrame();
    expect(store.hasLine(0)).toBe(true);

    store.registerLine(line(0, 0, "next"));
    store.begin({ row: 0, col: 0 });
    store.extend({ row: 0, col: 4 });
    expect(store.getSelectedText()).toBe("hello");

    store.commitFrame();
    expect(store.getSelectedText()).toBe("next");
  });

  it("drops rows that were not registered in the latest frame", () => {
    const store = createStore(line(0, 0, "a"), line(1, 0, "b"));
    store.registerLine(line(0, 0, "a"));
    store.commitFrame();
    expect(store.hasLine(0)).toBe(true);
    expect(store.hasLine(1)).toBe(false);
  });

  it("keeps a single anchor/focus pair and copies the ordered range", () => {
    const store = createStore(line(0, 0, "alpha"), line(1, 0, "beta"));
    store.begin({ row: 1, col: 2 });
    store.extend({ row: 0, col: 3 });
    expect(store.getBounds()).toEqual({
      start: { row: 0, col: 3 },
      end: { row: 1, col: 2 },
    });
    expect(store.getSelectedText()).toBe("ha\nbet");
  });

  it("treats a click without movement as no selection", () => {
    const store = createStore(line(0, 0, "hello"));
    store.begin({ row: 0, col: 2 });
    expect(store.hasSelection()).toBe(false);
    expect(store.getSelectedText()).toBe("");
  });

  it("selects all committed rows and clears the selection", () => {
    const store = createStore(line(0, 0, "hello"), line(1, 0, "world"));
    store.selectAll();
    expect(store.getSelectedText()).toBe("hello\nworld");

    const listener = vi.fn();
    store.subscribe(listener);
    store.clear();
    expect(store.hasSelection()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("notifies only when the selection changes", () => {
    const store = createStore(line(0, 0, "hello"));
    const listener = vi.fn();
    store.subscribe(listener);
    const version = store.getVersion();

    store.registerLine(line(1, 0, "next"));
    store.commitFrame();
    expect(store.getVersion()).toBe(version);
    expect(listener).not.toHaveBeenCalled();

    store.begin({ row: 0, col: 0 });
    expect(store.getVersion()).toBe(version + 1);
    store.extend({ row: 0, col: 0 });
    expect(store.getVersion()).toBe(version + 1);
    store.extend({ row: 0, col: 4 });
    expect(store.getVersion()).toBe(version + 2);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keeps cached text when the viewport scrolls without dragging", () => {
    const store = new TuiSelectionStore();
    store.setViewport({ topRow: 0, height: 4, offsetRows: 0 });
    for (let row = 0; row < 4; row += 1) {
      store.registerLine(line(row, 0, `line-${row}`));
    }
    store.commitFrame();
    store.begin({ row: 0, col: 0 });
    store.extend({ row: 2, col: 5 });
    store.endDrag();

    store.shiftViewport(2);
    store.setViewport({ topRow: 0, height: 4, offsetRows: 2 });

    expect(store.getSelectedText()).toBe("line-0\nline-1\nline-2");
    expect(store.hasLine(10)).toBe(false);
  });

  it("moves the drag focus with the viewport so the mouse stays on the edge", () => {
    const store = new TuiSelectionStore();
    store.setViewport({ topRow: 0, height: 4, offsetRows: 0 });
    for (let row = 0; row < 4; row += 1) {
      store.registerLine(line(row, 0, `line-${row}`));
    }
    store.commitFrame();
    store.begin({ row: 1, col: 0 });
    store.extend({ row: 3, col: 5 });

    store.shiftViewport(2);

    expect(store.getFocusScreenRow()).toBe(3);
    expect(store.getBounds()).toEqual({
      start: { row: 1, col: 0 },
      end: { row: 5, col: 5 },
    });
  });

  it("drops the cached lines and selection when content is reset", () => {
    const store = createStore(line(0, 0, "hello"));
    store.begin({ row: 0, col: 0 });
    store.extend({ row: 0, col: 4 });

    store.resetContent();

    expect(store.hasSelection()).toBe(false);
    expect(store.getSelectedText()).toBe("");
    expect(store.hasLine(0)).toBe(false);
  });
});
