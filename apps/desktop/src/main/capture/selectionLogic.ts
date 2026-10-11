export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type SelectionDecision =
  | { action: "none" }
  | { action: "cancel" }
  | { action: "confirm"; rect: Rect };

/** 把点 clamp 到 [0, max] 区间内（拖出窗口边缘时夹住）。 */
export function clampPoint(point: Point, maxX: number, maxY: number): Point {
  return {
    x: Math.min(Math.max(point.x, 0), maxX),
    y: Math.min(Math.max(point.y, 0), maxY),
  };
}

/** 由两个对角点归一化为左上角原点、宽高非负的矩形。 */
export function normalizeRect(start: Point, end: Point): Rect {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return {
    height: Math.abs(end.y - start.y),
    width: Math.abs(end.x - start.x),
    x,
    y,
  };
}

/**
 * 根据一次框选的输入决定动作：
 * - 从未 mousedown（start 为 null）→ none：忽略，避免误触取消 overlay；
 * - 选区小于 minSize → none：视为误触，overlay 保持，不静默消失；
 * - 选区足够大 → confirm；
 * 显式取消（Esc 等）由调用方直接 cancel，不走此函数。
 */
export function evaluateSelection(
  start: Point | null,
  end: Point,
  minSize: number,
): SelectionDecision {
  if (!start) return { action: "none" };
  const rect = normalizeRect(start, end);
  if (rect.width < minSize || rect.height < minSize) return { action: "none" };
  return { action: "confirm", rect };
}
