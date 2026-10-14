export interface ImeCandidateScreenAnchor {
  x: number;
  lineTop: number;
  lineBottom: number;
}

export interface ImeCandidateWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  placement: "above" | "below";
}

const EDGE_MARGIN = 8;
const CARET_GAP = 6;
const WINDOW_GUTTER = 8;

/** Places an independent candidate window inside the work area containing its caret. */
export function positionImeCandidate(
  anchor: ImeCandidateScreenAnchor,
  workArea: { x: number; y: number; width: number; height: number },
  requestedSize: { width: number; height: number },
): ImeCandidateWindowBounds {
  const areaRight = workArea.x + Math.max(1, workArea.width);
  const areaBottom = workArea.y + Math.max(1, workArea.height);
  const width = Math.min(
    Math.max(1, Math.round(requestedSize.width)),
    Math.max(1, workArea.width - EDGE_MARGIN * 2),
  );
  const height = Math.min(
    Math.max(1, Math.round(requestedSize.height)),
    Math.max(1, workArea.height - EDGE_MARGIN * 2),
  );
  const minX = workArea.x + EDGE_MARGIN;
  const maxX = Math.max(minX, areaRight - EDGE_MARGIN - width);
  const x = clamp(Math.round(anchor.x - WINDOW_GUTTER), minX, maxX);
  const belowY = Math.round(anchor.lineBottom + CARET_GAP - WINDOW_GUTTER);
  const aboveY = Math.round(anchor.lineTop - height - CARET_GAP);
  const placement = belowY + height <= areaBottom - EDGE_MARGIN ? "below" : "above";
  const preferredY = placement === "below" ? belowY : aboveY;
  const minY = workArea.y + EDGE_MARGIN;
  const maxY = Math.max(minY, areaBottom - EDGE_MARGIN - height);
  return { x, y: clamp(preferredY, minY, maxY), width, height, placement };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
