import { describe, expect, it } from "vitest";
import {
  createInitialCandidatePresentationState,
  matchesCandidatePresentation,
  reduceCandidatePresentationState,
  type CandidatePresentationContent,
} from "../src/main/ime/imeCandidatePresentationState";

const firstContent: CandidatePresentationContent = {
  targetId: "composer",
  generation: 1,
  state: {
    enabled: true,
    inputMode: "chinese",
    composing: true,
    preedit: "ni",
    candidates: ["你"],
    selectedIndex: 0,
    page: 0,
    hasNextPage: false,
  },
};

const secondContent: CandidatePresentationContent = {
  ...firstContent,
  generation: 2,
  state: { ...firstContent.state, preedit: "shi", candidates: ["是"] },
};

describe("candidate presentation state", () => {
  it("replaces content and identity atomically on show", () => {
    const first = reduceCandidatePresentationState(createInitialCandidatePresentationState(), {
      type: "show",
      content: firstContent,
    });
    const second = reduceCandidatePresentationState(first, {
      type: "show",
      content: secondContent,
    });

    expect(second).toEqual({ phase: "visible", content: secondContent, revision: 2 });
  });

  it("ignores stale clear and suspend for a previous lease", () => {
    const active = reduceCandidatePresentationState(createInitialCandidatePresentationState(), {
      type: "show",
      content: secondContent,
    });
    const staleSuspend = reduceCandidatePresentationState(active, {
      type: "suspend",
      targetId: firstContent.targetId,
      generation: firstContent.generation,
    });
    const staleClear = reduceCandidatePresentationState(staleSuspend, {
      type: "clear",
      targetId: firstContent.targetId,
      generation: firstContent.generation,
    });

    expect(staleClear).toBe(active);
    expect(matchesCandidatePresentation(staleClear, secondContent.targetId, 2)).toBe(true);
  });

  it("preserves content while suspended and advances revision when cleared", () => {
    const visible = reduceCandidatePresentationState(createInitialCandidatePresentationState(), {
      type: "show",
      content: firstContent,
    });
    const suspended = reduceCandidatePresentationState(visible, {
      type: "suspend",
      targetId: "composer",
      generation: 1,
    });
    const cleared = reduceCandidatePresentationState(suspended, {
      type: "clear",
      targetId: "composer",
      generation: 1,
    });

    expect(suspended).toEqual({ phase: "suspended", content: firstContent, revision: 1 });
    expect(cleared).toEqual({ phase: "empty", revision: 2 });
  });

  it("cannot revive content after disposal", () => {
    const visible = reduceCandidatePresentationState(createInitialCandidatePresentationState(), {
      type: "show",
      content: firstContent,
    });
    const disposed = reduceCandidatePresentationState(visible, { type: "dispose" });

    expect(
      reduceCandidatePresentationState(disposed, { type: "show", content: secondContent }),
    ).toBe(disposed);
  });
});
