import { describe, expect, it } from "vitest";
import { positionImeCandidate } from "../src/main/ime/imeCandidateLayout";

describe("positionImeCandidate", () => {
  const workArea = { x: 1920, y: 0, width: 1280, height: 1000 };
  const size = { width: 420, height: 52 };

  it("keeps the candidate popup aligned with a caret on a secondary display", () => {
    expect(
      positionImeCandidate({ x: 2200, lineTop: 300, lineBottom: 324 }, workArea, size),
    ).toEqual({ x: 2192, y: 322, width: 420, height: 52, placement: "below" });
  });

  it("flips above the caret and clamps to the work area edges", () => {
    expect(
      positionImeCandidate({ x: 3198, lineTop: 950, lineBottom: 974 }, workArea, size),
    ).toEqual({ x: 2772, y: 892, width: 420, height: 52, placement: "above" });
  });

  it("reduces window dimensions when the display work area is smaller", () => {
    expect(
      positionImeCandidate(
        { x: 0, lineTop: 0, lineBottom: 14 },
        { x: -100, y: 50, width: 300, height: 120 },
        { width: 500, height: 200 },
      ),
    ).toEqual({ x: -92, y: 58, width: 284, height: 104, placement: "below" });
  });
});
