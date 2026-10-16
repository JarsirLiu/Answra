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
  placement: "below";
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
  const minX = workArea.x + EDGE_MARGIN;
  const maxX = Math.max(minX, areaRight - EDGE_MARGIN - width);
  const x = clamp(Math.round(anchor.x - WINDOW_GUTTER), minX, maxX);
  const y = Math.max(
    workArea.y + EDGE_MARGIN,
    Math.round(anchor.lineBottom + CARET_GAP - WINDOW_GUTTER),
  );
  const availableBelow = Math.max(0, areaBottom - EDGE_MARGIN - y);
  const height = Math.min(
    Math.max(0, Math.round(requestedSize.height)),
    Math.max(0, workArea.height - EDGE_MARGIN * 2),
    availableBelow,
  );
  return { x, y, width, height, placement: "below" };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
