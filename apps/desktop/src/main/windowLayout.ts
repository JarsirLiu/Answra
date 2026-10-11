import type { RegionRect } from "@answra/shared";

const SELECTION_GAP = 12;

/** Computes a selection-relative position without knowing anything about Electron windows. */
export function positionWindowNearSelection(
  rect: RegionRect,
  displayBounds: { x: number; y: number },
  workArea: { x: number; y: number; width: number; height: number },
  windowSize: { width: number; height: number },
): { x: number; y: number } {
  const x = Math.round(rect.x + displayBounds.x + (rect.width - windowSize.width) / 2);
  const y = Math.round(rect.y + displayBounds.y + rect.height + SELECTION_GAP);
  return {
    x: Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - windowSize.width),
    y: Math.min(Math.max(y, workArea.y), workArea.y + workArea.height - windowSize.height),
  };
}

export function clampContentSize(
  size: { width: number; height: number },
  workArea: { width: number; height: number },
  margin: number,
  maxSize: { width: number; height: number },
): { width: number; height: number } {
  return {
    width: Math.min(size.width, maxSize.width, workArea.width - margin),
    height: Math.min(size.height, maxSize.height, workArea.height - margin),
  };
}
