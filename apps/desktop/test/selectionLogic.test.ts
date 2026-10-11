import { describe, expect, it } from "vitest";
import { clampPoint, evaluateSelection, normalizeRect } from "../src/main/capture/selectionLogic";

describe("selectionLogic", () => {
  it("clamps a point into the viewport bounds", () => {
    expect(clampPoint({ x: -5, y: 3 }, 100, 50)).toEqual({ x: 0, y: 3 });
    expect(clampPoint({ x: 200, y: 80 }, 100, 50)).toEqual({ x: 100, y: 50 });
  });

  it("normalizes two corners into a top-left rect", () => {
    expect(normalizeRect({ x: 30, y: 40 }, { x: 10, y: 20 })).toEqual({
      height: 20,
      width: 20,
      x: 10,
      y: 20,
    });
  });

  it("ignores a mouseup that had no prior mousedown", () => {
    expect(evaluateSelection(null, { x: 5, y: 5 }, 8)).toEqual({ action: "none" });
  });

  it("treats a tiny drag as a misclick and keeps the overlay open", () => {
    expect(evaluateSelection({ x: 10, y: 10 }, { x: 12, y: 13 }, 8)).toEqual({
      action: "none",
    });
  });

  it("confirms a drag larger than the minimum size", () => {
    expect(evaluateSelection({ x: 10, y: 10 }, { x: 100, y: 80 }, 8)).toEqual({
      action: "confirm",
      rect: { height: 70, width: 90, x: 10, y: 10 },
    });
  });
});
