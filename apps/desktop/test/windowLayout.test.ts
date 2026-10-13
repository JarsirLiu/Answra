import { describe, expect, it } from "vitest";
import {
  clampWindowBoundsToWorkArea,
  positionReplyBarSize,
  positionWindowNearPoint,
  replyBarAnchorFromBounds,
} from "../src/main/windowLayout";

const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
const barSize = { width: 480, height: 76 };

describe("positionReplyBarSize", () => {
  it("expands upward while keeping the reply bar bottom edge anchored", () => {
    expect(
      positionReplyBarSize({ x: 600, y: 700 }, workArea, { width: 560, height: 600 }, barSize),
    ).toEqual({
      x: 560,
      y: 176,
      placement: "above",
    });
  });

  it("expands below the bar when there is more room below", () => {
    expect(
      positionReplyBarSize({ x: 600, y: 300 }, workArea, { width: 560, height: 600 }, barSize),
    ).toEqual({
      x: 560,
      y: 300,
      placement: "below",
    });
  });

  it("clamps expanded bounds inside the work area", () => {
    const result = positionReplyBarSize(
      { x: 1800, y: 10 },
      { x: 100, y: 50, width: 800, height: 700 },
      { width: 560, height: 600 },
      barSize,
    );
    expect(result).toEqual({ x: 340, y: 50, placement: "below" });
  });

  it("rounds fractional bounds to native integers", () => {
    const result = positionReplyBarSize(
      { x: 600.4, y: 700.6 },
      { x: -1920.5, y: 0, width: 1920.5, height: 1080.5 },
      { width: 560.6, height: 600.4 },
      barSize,
    );
    expect(result).toEqual({ x: -561, y: 177, placement: "above" });
    expect(
      Object.values(result)
        .filter((value) => typeof value === "number")
        .every(Number.isInteger),
    ).toBe(true);
  });

  it("keeps positive bounds when the work area is smaller than the window margin", () => {
    const result = positionReplyBarSize(
      { x: -20, y: -10 },
      { x: -20, y: -10, width: 12, height: 18 },
      { width: 560, height: 600 },
      barSize,
    );
    expect(result).toEqual({ x: -20, y: -10, placement: "above" });
  });
});

describe("positionWindowNearPoint", () => {
  it("centers the reply bar on the final pointer position", () => {
    expect(
      positionWindowNearPoint({ x: 400, y: 300 }, { x: 0, y: 0 }, workArea, {
        width: 480,
        height: 76,
      }),
    ).toEqual({ x: 160, y: 312 });
  });

  it("clamps the reply bar when the pointer is near a display edge", () => {
    expect(
      positionWindowNearPoint({ x: 10, y: 1070 }, { x: 0, y: 0 }, workArea, {
        width: 480,
        height: 76,
      }),
    ).toEqual({ x: 0, y: 1004 });
  });
});

describe("reply window movement", () => {
  it("clamps the full window inside the matched display work area", () => {
    expect(
      clampWindowBoundsToWorkArea(
        { x: -100, y: 900, width: 560, height: 600 },
        { x: 100, y: 50, width: 800, height: 700 },
      ),
    ).toEqual({ x: 100, y: 150, width: 560, height: 600 });
  });

  it("keeps the reply bar position as the resize anchor for either expansion direction", () => {
    expect(
      replyBarAnchorFromBounds({ x: 500, y: 200, width: 560, height: 600 }, barSize, "above"),
    ).toEqual({ x: 540, y: 724 });
    expect(
      replyBarAnchorFromBounds({ x: 500, y: 200, width: 560, height: 600 }, barSize, "below"),
    ).toEqual({ x: 540, y: 200 });
  });
});
