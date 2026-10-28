import type { ImeState } from "@answra/shared";

/** Pure lifecycle model for the main-owned candidate window presentation. */
export type CandidatePresentationContent = {
  readonly state: ImeState;
  readonly targetId: string;
  readonly generation: number;
};

export type CandidatePresentationPhase = "empty" | "visible" | "suspended" | "disposed";

export type CandidatePresentationState = {
  readonly phase: CandidatePresentationPhase;
  readonly content?: CandidatePresentationContent;
  readonly revision: number;
};

export type CandidatePresentationEvent =
  | { type: "show"; content: CandidatePresentationContent }
  | { type: "suspend"; targetId: string; generation: number }
  | { type: "clear"; targetId: string; generation: number }
  | { type: "owner-closed" }
  | { type: "dispose" };

export function createInitialCandidatePresentationState(): CandidatePresentationState {
  return { phase: "empty", revision: 0 };
}

export function reduceCandidatePresentationState(
  current: CandidatePresentationState,
  event: CandidatePresentationEvent,
): CandidatePresentationState {
  if (current.phase === "disposed") return current;

  switch (event.type) {
    case "show":
      return { phase: "visible", content: event.content, revision: current.revision + 1 };
    case "suspend":
      if (!matchesContent(current, event.targetId, event.generation)) return current;
      return { ...current, phase: "suspended" };
    case "clear":
      if (!matchesContent(current, event.targetId, event.generation)) return current;
      return { phase: "empty", revision: current.revision + 1 };
    case "owner-closed":
      return { phase: "empty", revision: current.revision + 1 };
    case "dispose":
      return { phase: "disposed", revision: current.revision + 1 };
  }
}

export function matchesCandidatePresentation(
  state: CandidatePresentationState,
  targetId: string | undefined,
  generation: number | undefined,
): boolean {
  return (
    targetId !== undefined &&
    generation !== undefined &&
    matchesContent(state, targetId, generation)
  );
}

function matchesContent(
  state: CandidatePresentationState,
  targetId: string,
  generation: number,
): boolean {
  return state.content?.targetId === targetId && state.content.generation === generation;
}
