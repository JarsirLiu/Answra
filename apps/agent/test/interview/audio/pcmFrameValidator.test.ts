import { describe, expect, it } from "vitest";
import { PcmFrameValidator } from "../../../src/interview/audio/pcmFrameValidator";
import { conversationId, type InterviewSession, sessionId } from "../../../src/interview/contracts";

function createSession(id = "capture-1", state: InterviewSession["state"] = "listening") {
  return {
    sessionId: sessionId(id),
    conversationId: conversationId("active-exam-conversation"),
    state,
  } satisfies InterviewSession;
}

function frame(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "capture-1",
    source: "interviewer",
    sequence: 0,
    startSample: 0,
    sampleRate: 16_000,
    channels: 1,
    encoding: "pcm_s16le",
    pcm: new Uint8Array(3_200),
    ...overrides,
  };
}

describe("PcmFrameValidator", () => {
  it("accepts a valid 100 ms frame and takes ownership of its bytes", () => {
    const validator = new PcmFrameValidator(sessionId("capture-1"));
    const pcm = new Uint8Array(3_200);
    const result = validator.accept(frame({ pcm }), createSession());

    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.gap).toBeUndefined();
    expect(result.frame.pcm).toEqual(pcm);
    expect(result.frame.pcm).not.toBe(pcm);
  });

  it("tracks each audio source independently and permits a short final frame", () => {
    const validator = new PcmFrameValidator(sessionId("capture-1"));
    const interviewer = validator.accept(frame(), createSession());
    const candidate = validator.accept(frame({ source: "candidate" }), createSession());
    const finalShortFrame = validator.accept(
      frame({ sequence: 1, startSample: 1_600, pcm: new Uint8Array(320) }),
      createSession(),
    );

    expect(interviewer.accepted).toBe(true);
    expect(candidate.accepted).toBe(true);
    expect(finalShortFrame.accepted).toBe(true);
  });

  it("reports a missing frame as a gap and resumes continuity from the received frame", () => {
    const validator = new PcmFrameValidator(sessionId("capture-1"));
    validator.accept(frame(), createSession());

    const gap = validator.accept(frame({ sequence: 2, startSample: 3_200 }), createSession());
    expect(gap).toMatchObject({
      accepted: true,
      gap: {
        source: "interviewer",
        expectedSequence: 1,
        receivedSequence: 2,
        expectedStartSample: 1_600,
        receivedStartSample: 3_200,
      },
    });

    const next = validator.accept(frame({ sequence: 3, startSample: 4_800 }), createSession());
    expect(next).toMatchObject({ accepted: true });
    if (next.accepted) expect(next.gap).toBeUndefined();
  });

  it("rejects malformed formats, oversized payloads, duplicate frames, and overlaps", () => {
    const malformed: unknown[] = [
      frame({ sampleRate: 48_000 }),
      frame({ channels: 2 }),
      frame({ encoding: "wav" }),
      frame({ pcm: new Uint8Array(0) }),
      frame({ pcm: new Uint8Array(3) }),
      frame({ pcm: new Uint8Array(3_202) }),
      frame({ sequence: -1 }),
      frame({ startSample: Number.MAX_SAFE_INTEGER }),
      null,
    ];

    for (const invalid of malformed) {
      const result = new PcmFrameValidator(sessionId("capture-1")).accept(invalid, createSession());
      expect(result).toEqual({ accepted: false, code: "invalid-frame" });
    }

    const validator = new PcmFrameValidator(sessionId("capture-1"));
    validator.accept(frame(), createSession());
    expect(validator.accept(frame(), createSession())).toEqual({
      accepted: false,
      code: "out-of-order",
    });
    expect(validator.accept(frame({ sequence: 1, startSample: 800 }), createSession())).toEqual({
      accepted: false,
      code: "overlapping-audio",
    });
  });

  it("rejects frames from stale sessions and sessions that are not listening", () => {
    const validator = new PcmFrameValidator(sessionId("capture-2"));
    expect(validator.accept(frame(), createSession("capture-1"))).toEqual({
      accepted: false,
      code: "not-listening",
    });
    expect(validator.accept(frame({ sessionId: "capture-1" }), createSession("capture-2"))).toEqual(
      {
        accepted: false,
        code: "stale-session",
      },
    );
    expect(
      validator.accept(frame({ sessionId: "capture-2" }), createSession("capture-2", "stopping")),
    ).toEqual({ accepted: false, code: "not-listening" });
  });
});
