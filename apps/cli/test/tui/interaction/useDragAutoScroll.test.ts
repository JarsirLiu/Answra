import { afterEach, describe, expect, it, vi } from "vitest";
import { TuiSelectionStore } from "../../../src/tui/interaction/selectionStore";
import { startDragAutoScroll } from "../../../src/tui/interaction/useDragAutoScroll";

const AUTOSCROLL_INTERVAL_MS = 50;

function createDraggingStore(): TuiSelectionStore {
  const store = new TuiSelectionStore();
  store.setViewport({ topRow: 0, height: 10, offsetRows: 20 });
  store.begin({ row: 4, col: 0 });
  store.extend({ row: 9, col: 0 });
  return store;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("startDragAutoScroll", () => {
  it("scrolls immediately and repeats on the interval until the drag ends", () => {
    vi.useFakeTimers();
    const store = createDraggingStore();
    const scrollBy = vi.fn((delta: number) => {
      store.shiftViewport(delta);
      return delta;
    });
    const stop = startDragAutoScroll({ store, topRow: 0, bottomRow: 9, scrollBy });

    expect(scrollBy).toHaveBeenCalledTimes(1);
    expect(scrollBy).toHaveBeenLastCalledWith(2);

    vi.advanceTimersByTime(AUTOSCROLL_INTERVAL_MS);
    expect(scrollBy).toHaveBeenCalledTimes(2);
    expect(scrollBy).toHaveBeenLastCalledWith(2);

    vi.advanceTimersByTime(AUTOSCROLL_INTERVAL_MS * 2);
    expect(scrollBy).toHaveBeenCalledTimes(4);

    store.endDrag();
    vi.advanceTimersByTime(AUTOSCROLL_INTERVAL_MS * 5);
    expect(scrollBy).toHaveBeenCalledTimes(4);

    stop();
  });

  it("stops when scrollBy reports no movement", () => {
    vi.useFakeTimers();
    const store = createDraggingStore();
    const scrollBy = vi.fn().mockReturnValueOnce(2).mockReturnValue(0);
    const stop = startDragAutoScroll({ store, topRow: 0, bottomRow: 9, scrollBy });

    expect(scrollBy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(AUTOSCROLL_INTERVAL_MS);
    expect(scrollBy).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(AUTOSCROLL_INTERVAL_MS * 5);
    expect(scrollBy).toHaveBeenCalledTimes(2);

    stop();
  });

  it("stops and unsubscribes when the caller cleans up", () => {
    vi.useFakeTimers();
    const store = createDraggingStore();
    const scrollBy = vi.fn((delta: number) => {
      store.shiftViewport(delta);
      return delta;
    });
    const stop = startDragAutoScroll({ store, topRow: 0, bottomRow: 9, scrollBy });

    expect(scrollBy).toHaveBeenCalledTimes(1);
    stop();

    vi.advanceTimersByTime(AUTOSCROLL_INTERVAL_MS * 5);
    expect(scrollBy).toHaveBeenCalledTimes(1);

    store.endDrag();
    expect(scrollBy).toHaveBeenCalledTimes(1);
  });
});
