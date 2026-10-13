import type { RegionRect, ReplyBarPlacement } from "@answra/shared";

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

/** Places the reply bar below the pointer that completed the selection. */
export function positionWindowNearPoint(
  point: { x: number; y: number },
  displayBounds: { x: number; y: number },
  workArea: { x: number; y: number; width: number; height: number },
  windowSize: { width: number; height: number },
): { x: number; y: number } {
  const x = Math.round(point.x + displayBounds.x - windowSize.width / 2);
  const y = Math.round(point.y + displayBounds.y + SELECTION_GAP);
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

export function positionReplyBarSize(
  anchor: { x: number; y: number },
  workArea: { x: number; y: number; width: number; height: number },
  size: { width: number; height: number },
  barSize: { width: number; height: number },
): { x: number; y: number; placement: ReplyBarPlacement } {
  const areaX = finiteRound(workArea.x);
  const areaY = finiteRound(workArea.y);
  const areaWidth = Math.max(1, finiteFloor(workArea.width, 1));
  const areaHeight = Math.max(1, finiteFloor(workArea.height, 1));
  const width = clamp(finiteRound(size.width, 1), 1, areaWidth);
  const height = clamp(finiteRound(size.height, 1), 1, areaHeight);
  const barHeight = clamp(finiteRound(barSize.height, 1), 1, areaHeight);
  const anchorX = finiteRound(anchor.x);
  const anchorY = finiteRound(anchor.y);
  const expanded = height > barHeight + 20;
  const extraHeight = Math.max(0, height - barHeight);
  const aboveSpace = anchorY - areaY;
  const belowSpace = areaY + areaHeight - anchorY - barHeight;
  const placement: ReplyBarPlacement = !expanded
    ? "above"
    : aboveSpace >= extraHeight || aboveSpace >= belowSpace
      ? "above"
      : "below";
  const barWidth = finiteRound(barSize.width, width);
  const centeredX = anchorX + (barWidth - width) / 2;
  const x = clamp(finiteRound(centeredX), areaX, areaX + areaWidth - width);
  const preferredY = placement === "above" ? anchorY + barHeight - height : anchorY;
  const y = clamp(finiteRound(preferredY), areaY, areaY + areaHeight - height);
  return { x, y, placement };
}

export function clampWindowBoundsToWorkArea(
  bounds: { x: number; y: number; width: number; height: number },
  workArea: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const areaX = finiteRound(workArea.x);
  const areaY = finiteRound(workArea.y);
  const areaRight = areaX + Math.max(1, finiteFloor(workArea.width, 1));
  const areaBottom = areaY + Math.max(1, finiteFloor(workArea.height, 1));
  const width = Math.max(1, finiteRound(bounds.width, 1));
  const height = Math.max(1, finiteRound(bounds.height, 1));
  const maxX = Math.max(areaX, areaRight - width);
  const maxY = Math.max(areaY, areaBottom - height);
  return {
    x: clamp(finiteRound(bounds.x), areaX, maxX),
    y: clamp(finiteRound(bounds.y), areaY, maxY),
    width,
    height,
  };
}

export function replyBarAnchorFromBounds(
  bounds: { x: number; y: number; width: number; height: number },
  barSize: { width: number; height: number },
  placement: ReplyBarPlacement,
): { x: number; y: number } {
  return {
    x: bounds.x + Math.round((bounds.width - barSize.width) / 2),
    y: placement === "above" ? bounds.y + bounds.height - barSize.height : bounds.y,
  };
}

function finiteRound(value: number, fallback = 0): number {
  return Number.isFinite(value) ? Math.round(value) : fallback;
}

function finiteFloor(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.floor(value) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
