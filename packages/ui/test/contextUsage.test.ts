import { describe, expect, it } from "vitest";
import { contextUsagePercent, isReportedContextUsage } from "../src/app/contextUsage";

const USAGE = {
  contextWindow: 256_000,
  usedTokens: 212_300,
  source: "provider" as const,
  inputLimit: 216_000,
  compactAt: 216_000,
  pruneAt: 172_000,
  pruneTarget: 40_000,
  updatedAt: "2026-11-20T00:00:00.000Z",
};

describe("contextUsagePercent", () => {
  it("measures usage against the model context window, not the input limit", () => {
    expect(contextUsagePercent(USAGE)).toBe(83);
  });

  it("caps the percentage at 100", () => {
    expect(contextUsagePercent({ ...USAGE, usedTokens: 300_000 })).toBe(100);
  });

  it("treats provider and post-compaction estimates as reported usage", () => {
    expect(isReportedContextUsage(USAGE)).toBe(true);
    expect(isReportedContextUsage({ ...USAGE, source: "compaction" })).toBe(true);
    expect(isReportedContextUsage({ ...USAGE, source: "estimate" })).toBe(false);
  });
});
