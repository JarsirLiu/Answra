import { describe, expect, it } from "vitest";
import {
  type AudioSegment,
  conversationId,
  type InterviewDomainEvent,
  type InterviewSession,
  type InterviewTurnEvent,
  isCurrentListeningSession,
  type PcmFrame,
  replyGeneration,
  sessionId,
  type TranscriptEvent,
  transitionInterviewSession,
  turnId,
  utteranceId,
} from "../../src/interview/contracts";

describe("interview domain contracts", () => {
  it("rejects empty identity values and invalid reply generations", () => {
    expect(() => sessionId("  ")).toThrow("sessionId must not be empty");
    expect(() => conversationId(" ")).toThrow("conversationId must not be empty");
    expect(() => utteranceId("")).toThrow("utteranceId must not be empty");
    expect(() => turnId("\n")).toThrow("turnId must not be empty");
    expect(() => replyGeneration(-1)).toThrow(RangeError);
    expect(() => replyGeneration(Number.NaN)).toThrow(RangeError);
    expect(replyGeneration(0)).toBe(0);
  });

  it("keeps conversation history identity stable across listening session lifecycles", () => {
    const conversation = conversationId("active-exam-conversation");
    const initial: InterviewSession = {
      sessionId: sessionId("capture-1"),
      conversationId: conversation,
      state: "starting",
    };

    const ready = transitionInterviewSession(initial, {
      type: "capture-ready",
      sessionId: initial.sessionId,
    });
    expect(ready.accepted).toBe(true);
    if (!ready.accepted) return;
    expect(ready.session).toEqual({ ...initial, state: "listening" });
    expect(isCurrentListeningSession(ready.session, initial.sessionId)).toBe(true);

    const stopping = transitionInterviewSession(ready.session, {
      type: "stop-requested",
      sessionId: initial.sessionId,
    });
    expect(stopping.accepted).toBe(true);
    if (!stopping.accepted) return;
    expect(stopping.session.state).toBe("stopping");
    expect(isCurrentListeningSession(stopping.session, initial.sessionId)).toBe(false);

    const stopped = transitionInterviewSession(stopping.session, {
      type: "cleanup-completed",
      sessionId: initial.sessionId,
    });
    expect(stopped.accepted).toBe(true);
    if (!stopped.accepted) return;
    expect(stopped.session).toEqual({ ...initial, state: "stopped" });
    expect(stopped.session.conversationId).toBe(conversation);

    const restarted: InterviewSession = {
      sessionId: sessionId("capture-2"),
      conversationId: conversation,
      state: "starting",
    };
    const lateOldEvent = transitionInterviewSession(restarted, {
      type: "capture-ready",
      sessionId: initial.sessionId,
    });
    expect(lateOldEvent).toEqual({
      accepted: false,
      reason: "stale-session",
      session: restarted,
    });
    expect(restarted.conversationId).toBe(initial.conversationId);
    expect(isCurrentListeningSession(restarted, initial.sessionId)).toBe(false);
  });

  it("rejects invalid lifecycle transitions and treats repeated stop as idempotent", () => {
    const starting: InterviewSession = {
      sessionId: sessionId("capture-1"),
      conversationId: conversationId("active-exam-conversation"),
      state: "starting",
    };
    expect(
      transitionInterviewSession(starting, {
        type: "cleanup-completed",
        sessionId: starting.sessionId,
      }),
    ).toMatchObject({ accepted: false, reason: "invalid-transition" });

    const stopping = {
      ...starting,
      state: "stopping" as const,
    };
    expect(
      transitionInterviewSession(stopping, {
        type: "stop-requested",
        sessionId: stopping.sessionId,
      }),
    ).toEqual({ accepted: true, session: stopping });
  });

  it("keeps a finalized ASR chunk distinct from a committed interviewer turn", () => {
    const chunk: TranscriptEvent = {
      kind: "chunk-final",
      sessionId: sessionId("session-1"),
      source: "interviewer",
      utteranceId: utteranceId("utterance-1"),
      chunkIndex: 0,
      startSample: 0,
      endSample: 16_000,
      revision: 0,
      text: "问题前半段",
    };
    const event: InterviewDomainEvent = { type: "transcript-event", event: chunk };
    const committed: InterviewTurnEvent = {
      type: "turn-committed",
      turn: {
        sessionId: chunk.sessionId,
        conversationId: conversationId("active-exam-conversation"),
        turnId: turnId("turn-1"),
        version: 1,
        status: "committed",
        chunks: [
          {
            utteranceId: chunk.utteranceId,
            chunkIndex: chunk.chunkIndex,
            startSample: chunk.startSample,
            endSample: chunk.endSample,
            text: chunk.text,
          },
        ],
        missingChunkIndexes: [],
      },
    };

    expect(event.type).toBe("transcript-event");
    expect(event.event.kind).toBe("chunk-final");
    expect(committed.turn.status).toBe("committed");
  });

  it("measures frame and segment ranges in sample frames, independent of wall clocks", () => {
    const pcm = new Uint8Array(3_200);
    const frame: PcmFrame = {
      sessionId: sessionId("session-1"),
      source: "interviewer",
      sequence: 2,
      startSample: 3_200,
      sampleRate: 16_000,
      channels: 1,
      encoding: "pcm_s16le",
      pcm,
    };
    const segment: AudioSegment = {
      sessionId: frame.sessionId,
      source: frame.source,
      utteranceId: utteranceId("utterance-1"),
      chunkIndex: 0,
      startSample: frame.startSample,
      endSample: frame.startSample + pcm.byteLength / 2,
      sampleRate: frame.sampleRate,
      channels: frame.channels,
      encoding: frame.encoding,
      pcm,
      boundary: "continuation",
    };

    expect((segment.endSample - segment.startSample) / segment.sampleRate).toBe(0.1);

    const cloned = structuredClone(frame);
    expect(cloned.pcm).toBeInstanceOf(Uint8Array);
    expect(cloned.pcm).toEqual(frame.pcm);
  });
});
