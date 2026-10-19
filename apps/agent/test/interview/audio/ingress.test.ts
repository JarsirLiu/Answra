import { describe, expect, it, vi } from "vitest";
import { InterviewAudioIngress } from "../../../src/interview/audio/ingress";
import {
  conversationId,
  type InterviewDomainEvent,
  sessionId,
} from "../../../src/interview/contracts";

function frame(session = "capture-1", sequence = 0, startSample = 0) {
  return {
    sessionId: session,
    source: "interviewer",
    sequence,
    startSample,
    sampleRate: 16_000,
    channels: 1,
    encoding: "pcm_s16le",
    pcm: new Uint8Array(3_200),
  };
}

function createIngress() {
  const events: InterviewDomainEvent[] = [];
  const frames: unknown[] = [];
  const ingress = new InterviewAudioIngress({
    emit: (event) => events.push(event),
    onFrame: (audioFrame) => frames.push(audioFrame),
  });
  return { events, frames, ingress };
}

describe("InterviewAudioIngress", () => {
  it("starts listening only after capture is ready and forwards validated system audio", () => {
    const { events, frames, ingress } = createIngress();
    const current = ingress.start(
      sessionId("capture-1"),
      conversationId("active-exam-conversation"),
    );
    expect(current.state).toBe("starting");
    expect(ingress.acceptFrame(frame())).toEqual({ accepted: false, code: "not-listening" });

    expect(ingress.captureReady(current.sessionId)).toBe(true);
    const accepted = ingress.acceptFrame(frame());
    expect(accepted.accepted).toBe(true);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ source: "interviewer", sessionId: current.sessionId });
    expect(events.map((event) => event.type)).toEqual([
      "session-state-changed",
      "session-started",
      "session-state-changed",
    ]);
  });

  it("publishes audio gaps and continues forwarding later frames", () => {
    const { events, frames, ingress } = createIngress();
    const session = ingress.start(
      sessionId("capture-1"),
      conversationId("active-exam-conversation"),
    );
    ingress.captureReady(session.sessionId);

    ingress.acceptFrame(frame());
    const gap = ingress.acceptFrame(frame("capture-1", 2, 3_200));

    expect(gap).toMatchObject({ accepted: true, gap: { expectedSequence: 1 } });
    expect(events).toContainEqual({
      type: "audio-gap",
      sessionId: session.sessionId,
      source: "interviewer",
      expectedSequence: 1,
      receivedSequence: 2,
      expectedStartSample: 1_600,
      receivedStartSample: 3_200,
    });
    expect(frames).toHaveLength(2);
  });

  it("stops accepting frames, then allows a new capture run on the same conversation", () => {
    const { events, frames, ingress } = createIngress();
    const conversation = conversationId("active-exam-conversation");
    const first = ingress.start(sessionId("capture-1"), conversation);
    ingress.captureReady(first.sessionId);
    ingress.acceptFrame(frame());

    expect(ingress.stop(first.sessionId)).toBe(true);
    expect(ingress.acceptFrame(frame("capture-1", 1, 1_600))).toEqual({
      accepted: false,
      code: "not-listening",
    });

    const restarted = ingress.start(sessionId("capture-2"), conversation);
    expect(restarted.conversationId).toBe(conversation);
    ingress.captureReady(restarted.sessionId);
    expect(ingress.acceptFrame(frame("capture-1"))).toEqual({
      accepted: false,
      code: "stale-session",
    });
    expect(ingress.acceptFrame(frame("capture-2")).accepted).toBe(true);
    expect(frames).toHaveLength(2);
    expect(events).toContainEqual({
      type: "session-stopped",
      sessionId: first.sessionId,
      conversationId: conversation,
    });
  });

  it("fails a capture session and rejects stale or repeated lifecycle events", () => {
    const { events, frames, ingress } = createIngress();
    const session = ingress.start(
      sessionId("capture-1"),
      conversationId("active-exam-conversation"),
    );

    expect(ingress.captureReady(sessionId("other-session"))).toBe(false);
    expect(ingress.fail(session.sessionId, "capture-failed")).toBe(true);
    expect(ingress.captureReady(session.sessionId)).toBe(false);
    expect(ingress.fail(session.sessionId, "runtime-failed")).toBe(false);
    expect(ingress.acceptFrame(frame()).accepted).toBe(false);
    expect(frames).toHaveLength(0);
    expect(events).toContainEqual({
      type: "session-failed",
      sessionId: session.sessionId,
      conversationId: session.conversationId,
      code: "capture-failed",
    });
  });

  it("does not publish to consumers after startup failures", () => {
    const emit = vi.fn();
    const onFrame = vi.fn();
    const ingress = new InterviewAudioIngress({ emit, onFrame });
    const session = ingress.start(
      sessionId("capture-1"),
      conversationId("active-exam-conversation"),
    );
    ingress.fail(session.sessionId, "capture-failed");

    expect(ingress.acceptFrame(frame()).accepted).toBe(false);
    expect(onFrame).not.toHaveBeenCalled();
  });
});
