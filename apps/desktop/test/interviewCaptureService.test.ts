import type { InterviewPcmFrame } from "@answra/shared";
import { describe, expect, it, vi } from "vitest";
import { InterviewCaptureService } from "../src/main/interview/interviewCaptureService";

function createAgent() {
  return {
    startInterview: vi.fn(async () => undefined),
    markInterviewCaptureReady: vi.fn(async () => undefined),
    failInterviewCapture: vi.fn(async () => undefined),
    stopInterview: vi.fn(async () => undefined),
    sendInterviewPcmFrame: vi.fn(),
  };
}

function pcmFrame(sessionId: string): InterviewPcmFrame {
  return {
    sessionId,
    source: "candidate",
    sequence: 0,
    startSample: 0,
    sampleRate: 16_000,
    channels: 1,
    encoding: "pcm_s16le",
    pcm: new Uint8Array(3_200),
  };
}

describe("InterviewCaptureService", () => {
  it("accepts frames only for the ready active session and releases it on stop", async () => {
    const agent = createAgent();
    const service = new InterviewCaptureService(agent as never);
    const { sessionId } = await service.start("active-interview-conversation");

    expect(service.acceptFrame(pcmFrame(sessionId))).toBe(false);
    expect(await service.captureReady(sessionId)).toBe(true);
    expect(service.acceptFrame(pcmFrame("stale-session"))).toBe(false);
    expect(service.acceptFrame(pcmFrame(sessionId))).toBe(true);
    expect(agent.sendInterviewPcmFrame).toHaveBeenCalledWith(pcmFrame(sessionId));
    expect(await service.stop(sessionId)).toBe(true);
    expect(service.acceptFrame(pcmFrame(sessionId))).toBe(false);
    expect(agent.stopInterview).toHaveBeenCalledWith(sessionId);
  });

  it("allows microphone permission only while capture is starting", async () => {
    const service = new InterviewCaptureService(createAgent() as never);
    const { sessionId } = await service.start("active-interview-conversation");

    expect(service.allowsMicrophonePermission()).toBe(true);
    expect(await service.captureReady(sessionId)).toBe(true);
    expect(service.allowsMicrophonePermission()).toBe(false);
  });

  it("rejects frames for a different session before crossing into the Agent process", async () => {
    const agent = createAgent();
    const service = new InterviewCaptureService(agent as never);
    const { sessionId } = await service.start("active-interview-conversation");
    await service.captureReady(sessionId);

    expect(service.acceptFrame(pcmFrame("other-session"))).toBe(false);
    expect(agent.sendInterviewPcmFrame).not.toHaveBeenCalled();
  });
});
