import { describe, expect, it } from "vitest";
import { scoreTurnEnds } from "./eot-bench-metrics";

describe("eot-bench turn-end scoring", () => {
  it("counts natural end detection and measures when the segment became available", () => {
    const score = scoreTurnEnds(
      [{ endSample: 79_200, observedSample: 91_200 }],
      [{ start: 2 }, { start: 5 }],
      16_000,
      500,
    );

    expect(score).toEqual({
      eotDetected: true,
      eotDetectionLatencyMs: 700,
      holdFalseCutoffs: 0,
      falseTurnEnds: 0,
    });
  });

  it("counts internal pause closures as false turn ends and leaves an undetected EOT as a miss", () => {
    const score = scoreTurnEnds(
      [{ endSample: 32_000, observedSample: 44_000 }],
      [{ start: 2 }, { start: 5 }],
      16_000,
      500,
    );

    expect(score).toEqual({
      eotDetected: false,
      eotDetectionLatencyMs: undefined,
      holdFalseCutoffs: 1,
      falseTurnEnds: 1,
    });
  });

  it("ignores boundaries outside the annotation tolerance", () => {
    const score = scoreTurnEnds(
      [{ endSample: 48_000, observedSample: 60_000 }],
      [{ start: 5 }],
      16_000,
      500,
    );

    expect(score.eotDetected).toBe(false);
    expect(score.holdFalseCutoffs).toBe(0);
    expect(score.falseTurnEnds).toBe(1);
  });
});
