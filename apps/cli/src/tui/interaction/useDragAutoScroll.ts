/** 拖拽选区停在视口边缘时的自动滚动节拍；滚动本身由投影视口注入。 */
import { useEffect } from "react";
import type { TuiSelectionStore } from "./selectionStore";

const AUTOSCROLL_LINES = 2;
const AUTOSCROLL_INTERVAL_MS = 50;
const AUTOSCROLL_MAX_TICKS = 200;

export interface DragAutoScrollOptions {
  readonly store: TuiSelectionStore | undefined;
  readonly topRow: number;
  readonly bottomRow: number;
  /** 返回实际滚动行数；0 表示已到边界。 */
  readonly scrollBy: (delta: number) => number;
}

export function startDragAutoScroll({
  store,
  topRow,
  bottomRow,
  scrollBy,
}: DragAutoScrollOptions): () => void {
  if (store === undefined) return () => {};
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticks = 0;
  let ticking = false;
  const stop = (): void => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  };
  const tick = (): boolean => {
    if (ticking) return false;
    ticking = true;
    try {
      const direction = store.dragScrollDirection(topRow, bottomRow);
      if (direction === 0 || ticks >= AUTOSCROLL_MAX_TICKS) {
        stop();
        return false;
      }
      ticks += 1;
      if (scrollBy(direction * AUTOSCROLL_LINES) === 0) {
        stop();
        return false;
      }
      return true;
    } finally {
      ticking = false;
    }
  };
  const check = (): void => {
    if (ticking) return;
    if (store.dragScrollDirection(topRow, bottomRow) === 0) {
      stop();
      return;
    }
    if (timer !== undefined) return;
    ticks = 0;
    if (!tick()) return;
    timer = setInterval(() => {
      if (!tick()) stop();
    }, AUTOSCROLL_INTERVAL_MS);
  };
  const unsubscribe = store.subscribe(check);
  check();
  return () => {
    unsubscribe();
    stop();
  };
}

export function useDragAutoScroll(options: DragAutoScrollOptions): void {
  const { store, topRow, bottomRow, scrollBy } = options;
  useEffect(
    () => startDragAutoScroll({ store, topRow, bottomRow, scrollBy }),
    [bottomRow, scrollBy, store, topRow],
  );
}
