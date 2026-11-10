import { describe, expect, it } from "vitest";
import { runOutcome } from "../../../src/core/agent/executeRun";
import type { RunMetrics } from "../../../src/core/agent/streamJournal";

const completedMetrics: RunMetrics = {
  chunkCounts: {},
  textLength: 1,
  reasoningLength: 0,
  started: true,
  failed: false,
  finished: true,
  aborted: false,
};

describe("agent run outcome", () => {
  it("fails a run that ends while the model still wants tools", () => {
    expect(runOutcome(false, completedMetrics, "tool-calls")).toBe("failed");
  });

  it("completes a run with a terminal text answer", () => {
    expect(runOutcome(false, completedMetrics, "stop")).toBe("completed");
  });

  it("keeps cancellation and missing terminal facts explicit", () => {
    expect(runOutcome(true, completedMetrics, "stop")).toBe("aborted");
    expect(runOutcome(false, { ...completedMetrics, finished: false }, "stop")).toBe("failed");
  });
});
