import { describe, expect, it, vi } from "vitest";
import {
  type CommittedInterviewTurn,
  conversationId,
  sessionId,
  turnId,
  utteranceId,
} from "../../../src/interview/contracts";
import { CandidateTurnSettler } from "../../../src/interview/turns/settler";

const session = sessionId("session-a");
const conversation = conversationId("active-interview-conversation");

function committedTurn(utterance: string, texts: string[]): CommittedInterviewTurn {
  return {
    sessionId: session,
    conversationId: conversation,
    turnId: turnId(`${session}:${utterance}`),
    version: 0,
    status: "committed",
    chunks: texts.map((text, index) => ({
      utteranceId: utteranceId(utterance),
      chunkIndex: index,
      startSample: index * 1_600,
      endSample: (index + 1) * 1_600,
      text,
    })),
    missingChunkIndexes: [],
  };
}

describe("CandidateTurnSettler", () => {
  it("merges consecutive committed turns into one settled message within the window", () => {
    vi.useFakeTimers();
    const onSettled = vi.fn();
    const settler = new CandidateTurnSettler({ settleMs: 1_000, minTurnChars: 2 }, { onSettled });

    settler.receive(committedTurn("utterance-1", ["请介绍"]));
    settler.receive(committedTurn("utterance-2", ["你的项目"]));
    vi.advanceTimersByTime(1_000);

    expect(onSettled).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledWith(
      [committedTurn("utterance-1", ["请介绍"]), committedTurn("utterance-2", ["你的项目"])],
      "请介绍你的项目",
    );
    vi.useRealTimers();
  });

  it("joins unordered chunks by chunkIndex when settling", () => {
    vi.useFakeTimers();
    const onSettled = vi.fn();
    const settler = new CandidateTurnSettler({ settleMs: 1_000, minTurnChars: 2 }, { onSettled });

    const turn = committedTurn("utterance-1", ["第一段", "第二段"]);
    settler.receive({ ...turn, chunks: [...turn.chunks].reverse() });
    vi.advanceTimersByTime(1_000);

    expect(onSettled).toHaveBeenCalledWith(expect.anything(), "第一段第二段");
    vi.useRealTimers();
  });

  it("settles each turn immediately when the window is zero", () => {
    const onSettled = vi.fn();
    const settler = new CandidateTurnSettler({ settleMs: 0, minTurnChars: 2 }, { onSettled });

    settler.receive(committedTurn("utterance-1", ["请介绍"]));
    settler.receive(committedTurn("utterance-2", ["你的项目"]));

    expect(onSettled).toHaveBeenCalledTimes(2);
  });

  it("drops sub-threshold merged turns without emitting", () => {
    vi.useFakeTimers();
    const onSettled = vi.fn();
    const settler = new CandidateTurnSettler({ settleMs: 1_000, minTurnChars: 2 }, { onSettled });

    settler.receive(committedTurn("utterance-1", ["嗯"]));
    vi.advanceTimersByTime(1_000);

    expect(onSettled).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("keeps pending state until the window expires, flushing on demand", () => {
    vi.useFakeTimers();
    const onSettled = vi.fn();
    const settler = new CandidateTurnSettler({ settleMs: 1_000, minTurnChars: 2 }, { onSettled });

    settler.receive(committedTurn("utterance-1", ["请介绍"]));
    settler.flush(session);

    expect(onSettled).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledWith(expect.anything(), "请介绍");
    vi.useRealTimers();
  });

  it("discards pending turns without settling and clears timers", () => {
    vi.useFakeTimers();
    const onSettled = vi.fn();
    const settler = new CandidateTurnSettler({ settleMs: 1_000, minTurnChars: 2 }, { onSettled });

    settler.receive(committedTurn("utterance-1", ["请介绍"]));
    settler.discard(session);
    vi.advanceTimersByTime(2_000);

    expect(onSettled).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("defers settling while a later turn keeps postponing the window", () => {
    vi.useFakeTimers();
    const onSettled = vi.fn();
    const settler = new CandidateTurnSettler({ settleMs: 1_000, minTurnChars: 2 }, { onSettled });

    settler.receive(committedTurn("utterance-1", ["第一"]));
    vi.advanceTimersByTime(900);
    settler.receive(committedTurn("utterance-2", ["第二"]));
    vi.advanceTimersByTime(900);
    // 顺延窗口尚未耗尽：不结算
    expect(onSettled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);

    expect(onSettled).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("discards everything on disposeAll", () => {
    vi.useFakeTimers();
    const onSettled = vi.fn();
    const settler = new CandidateTurnSettler({ settleMs: 1_000, minTurnChars: 2 }, { onSettled });

    settler.receive(committedTurn("utterance-1", ["请介绍"]));
    settler.discardAll();
    vi.advanceTimersByTime(2_000);

    expect(onSettled).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
