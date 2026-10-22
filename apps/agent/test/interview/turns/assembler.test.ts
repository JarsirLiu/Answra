import { describe, expect, it } from "vitest";
import {
  type AudioSegment,
  conversationId,
  sessionId,
  type TranscriptEvent,
  utteranceId,
} from "../../../src/interview/contracts";
import { InterviewTurnAssembler } from "../../../src/interview/turns/assembler";

const session = sessionId("session-a");
const utterance = utteranceId("utterance-a");
const conversation = conversationId("active-interview-conversation");

function segment(chunkIndex: number, boundary: AudioSegment["boundary"]): AudioSegment {
  return {
    sessionId: session,
    source: "candidate",
    utteranceId: utterance,
    chunkIndex,
    startSample: chunkIndex * 1_600,
    endSample: (chunkIndex + 1) * 1_600,
    sampleRate: 16_000,
    channels: 1,
    encoding: "pcm_s16le",
    pcm: new Uint8Array(3_200),
    boundary,
  };
}

function finalEvent(
  chunkIndex: number,
  boundary: AudioSegment["boundary"],
  text: string,
): TranscriptEvent {
  return {
    sessionId: session,
    source: "candidate",
    utteranceId: utterance,
    chunkIndex,
    startSample: chunkIndex * 1_600,
    endSample: (chunkIndex + 1) * 1_600,
    revision: 0,
    boundary,
    kind: "chunk-final",
    text,
  };
}

describe("InterviewTurnAssembler", () => {
  it("commits one natural utterance only after every ASR chunk arrives in order", () => {
    const assembler = new InterviewTurnAssembler();
    assembler.registerSegment(segment(0, "continuation"), conversation);
    assembler.registerSegment(segment(1, "utterance-end"), conversation);

    expect(assembler.accept(finalEvent(1, "utterance-end", "第二段"))).toBeUndefined();
    const turn = assembler.accept(finalEvent(0, "continuation", "第一段"));

    expect(turn).toMatchObject({
      sessionId: session,
      conversationId: conversation,
      status: "committed",
      chunks: [
        { chunkIndex: 0, text: "第一段" },
        { chunkIndex: 1, text: "第二段" },
      ],
      missingChunkIndexes: [],
    });
    expect(assembler.accept(finalEvent(1, "utterance-end", "第二段"))).toBeUndefined();
  });

  it("does not commit failed or non-microphone segments", () => {
    const assembler = new InterviewTurnAssembler();
    assembler.registerSegment(segment(0, "utterance-end"), conversation);
    expect(
      assembler.accept({
        ...finalEvent(0, "utterance-end", ""),
        kind: "error",
        code: "provider-error",
        retryable: false,
      }),
    ).toBeUndefined();

    assembler.registerSegment(
      { ...segment(0, "utterance-end"), source: "interviewer" },
      conversation,
    );
    expect(assembler.accept(finalEvent(0, "utterance-end", "系统声音"))).toBeUndefined();
  });
});
