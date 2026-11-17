import { describe, expect, it } from "vitest";
import { TuiSelectionStore } from "../../../src/tui/interaction/selectionStore";

function draggingSelection(anchorRow: number, focusRow: number): TuiSelectionStore {
  const store = new TuiSelectionStore();
  store.setViewport({ topRow: 0, height: 5, offsetRows: 10 });
  store.begin({ row: anchorRow, col: 0 });
  store.extend({ row: focusRow, col: 0 });
  return store;
}

describe("TuiSelectionStore dragScrollDirection", () => {
  it("scrolls up when the focus is at the top edge below the anchor", () => {
    const store = draggingSelection(3, 0);
    expect(store.dragScrollDirection(0, 4)).toBe(-1);
  });

  it("scrolls down when the focus is at the bottom edge above the anchor", () => {
    const store = draggingSelection(1, 4);
    expect(store.dragScrollDirection(0, 4)).toBe(1);
  });

  it("does not scroll while the focus stays inside the viewport", () => {
    const store = draggingSelection(1, 3);
    expect(store.dragScrollDirection(0, 4)).toBe(0);
  });

  it("does not scroll after the drag ends", () => {
    const store = draggingSelection(1, 4);
    store.endDrag();
    expect(store.dragScrollDirection(0, 4)).toBe(0);
  });
});
