import { describe, expect, it } from "vitest";
import {
  contextBudgetPolicyForWindow,
  DEFAULT_CONTEXT_BUDGET_POLICY,
  resolveContextBudget,
} from "../../../src/core/context/budget";

describe("context budget", () => {
  it("resolves the 256k window to a 216k input limit and compaction point", () => {
    expect(resolveContextBudget()).toMatchObject({
      contextWindow: 256_000,
      maxOutputTokens: 20_000,
      safetyTokens: 12_000,
      fixedOverheadTokens: 8_000,
      compactionBuffer: 40_000,
      inputLimit: 216_000,
      compactAt: 216_000,
      pruneAt: 172_000,
      pruneTarget: 40_000,
      minPruneSaving: 132_000,
      postCompactTarget: 120_000,
    });
  });

  it("scales prune and compaction thresholds down with the model window", () => {
    expect(resolveContextBudget(contextBudgetPolicyForWindow(128_000))).toMatchObject({
      contextWindow: 128_000,
      maxOutputTokens: 10_000,
      safetyTokens: 6_000,
      fixedOverheadTokens: 4_000,
      compactionBuffer: 20_000,
      inputLimit: 108_000,
      compactAt: 108_000,
      pruneAt: 86_000,
      pruneTarget: 20_000,
      minPruneSaving: 66_000,
      postCompactTarget: 60_000,
    });
  });

  it("keeps the compaction point below the input limit when the buffer is larger", () => {
    expect(
      resolveContextBudget({
        ...DEFAULT_CONTEXT_BUDGET_POLICY,
        compactionBuffer: 80_000,
      }),
    ).toMatchObject({ inputLimit: 216_000, compactAt: 176_000 });
  });

  it("rejects a tool cleanup trigger that is not below the compaction point", () => {
    expect(() =>
      resolveContextBudget({
        ...DEFAULT_CONTEXT_BUDGET_POLICY,
        pruneAt: 216_000,
      }),
    ).toThrow("工具结果清理触发点必须低于摘要压缩触发点");
  });

  it("rejects invalid allocation instead of silently truncating", () => {
    expect(() =>
      resolveContextBudget({
        ...DEFAULT_CONTEXT_BUDGET_POLICY,
        contextWindow: 30_000,
      }),
    ).toThrow("上下文窗口不足以容纳输出、安全余量与固定开销");
  });
});
