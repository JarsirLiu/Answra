import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { ContextLimitExceededError, resolveContextBudget } from "../../../src/core/context/budget";
import { trimContextRequest } from "../../../src/core/context/trim";

const BUDGET = resolveContextBudget({
  contextWindow: 3_000,
  maxOutputTokens: 50,
  safetyTokens: 100,
  fixedOverheadTokens: 100,
  compactionBuffer: 1_000,
  pruneAt: 500,
  pruneTarget: 100,
  minPruneSaving: 400,
  postCompactTarget: 1_200,
  summaryMaxTokens: 200,
});

function message(role: "user" | "assistant", content: string): ModelMessage {
  return { role, content };
}

describe("context trimming", () => {
  it("drops the oldest complete turn until the request fits the input limit", () => {
    const request = {
      system: "",
      messages: [
        message("user", "a".repeat(4_000)),
        message("assistant", "b".repeat(4_000)),
        message("user", "c".repeat(4_000)),
      ],
    };

    const result = trimContextRequest(request, BUDGET);

    expect(result.messages).toEqual([message("user", "c".repeat(4_000))]);
  });

  it("trims to a soft target while preserving the leading summary message", () => {
    const request = {
      system: "",
      messages: [
        message("user", "summary"),
        message("user", "a".repeat(4_000)),
        message("assistant", "b".repeat(4_000)),
        message("user", "current"),
      ],
    };

    const result = trimContextRequest(request, BUDGET, {
      targetTokens: 1_200,
      preserveLeadingMessages: 1,
    });

    expect(result.messages).toEqual([message("user", "summary"), message("user", "current")]);
  });

  it("fails closed when the current request alone exceeds the input limit", () => {
    const request = {
      system: "",
      messages: [message("user", "a".repeat(12_000))],
    };

    expect(() => trimContextRequest(request, BUDGET)).toThrow(ContextLimitExceededError);
  });

  it("keeps the original request when it already fits", () => {
    const request = {
      system: "sys",
      messages: [message("user", "hello")],
    };

    expect(trimContextRequest(request, BUDGET)).toBe(request);
  });
});
