import { describe, expect, it, vi } from "vitest";
import type { ClipboardWriter } from "../src/tui/interaction/clipboard";
import { createSelectionActions } from "../src/tui/interaction/selectionActions";
import { TuiSelectionStore } from "../src/tui/interaction/selectionStore";

function createStore(): TuiSelectionStore {
  const store = new TuiSelectionStore();
  store.registerLine({ row: 0, left: 0, text: "hello" });
  store.registerLine({ row: 1, left: 0, text: "world" });
  store.commitFrame();
  return store;
}

describe("selection actions", () => {
  it("copies on release after a drag over a registered line", () => {
    const store = createStore();
    const clipboard: ClipboardWriter = { write: vi.fn() };
    const actions = createSelectionActions(store, clipboard);

    actions.handlePointer({ kind: "press", point: { row: 0, col: 0 } });
    actions.handlePointer({ kind: "drag", point: { row: 0, col: 4 } });
    actions.handlePointer({ kind: "release", point: { row: 0, col: 4 } });

    expect(clipboard.write).toHaveBeenCalledWith("hello");
  });

  it("does not start a selection on an unregistered row and clears the old one", () => {
    const store = createStore();
    store.begin({ row: 0, col: 0 });
    store.extend({ row: 0, col: 4 });
    const clipboard: ClipboardWriter = { write: vi.fn() };
    const actions = createSelectionActions(store, clipboard);

    actions.handlePointer({ kind: "press", point: { row: 9, col: 0 } });

    expect(store.hasSelection()).toBe(false);
    expect(clipboard.write).not.toHaveBeenCalled();
  });

  it("selects all registered lines and copies them", () => {
    const store = createStore();
    const clipboard: ClipboardWriter = { write: vi.fn() };
    const actions = createSelectionActions(store, clipboard);

    actions.selectAllAndCopy();

    expect(clipboard.write).toHaveBeenCalledWith("hello\nworld");
  });

  it("ignores wheel events and empty releases", () => {
    const store = createStore();
    const clipboard: ClipboardWriter = { write: vi.fn() };
    const actions = createSelectionActions(store, clipboard);

    actions.handlePointer({ kind: "wheel", direction: 1, point: { row: 0, col: 0 } });
    actions.handlePointer({ kind: "release", point: { row: 0, col: 0 } });

    expect(clipboard.write).not.toHaveBeenCalled();
  });
});
