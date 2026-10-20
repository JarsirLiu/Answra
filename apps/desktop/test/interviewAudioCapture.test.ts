import { ActiveInterviewConversationId } from "@answra/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InterviewAudioCapture } from "../src/renderer/interviewAudioCapture";

class FakeAudioContext {
  state = "running";
  sampleRate = 16_000;
  destination = {};
  audioWorklet = { addModule: vi.fn(async () => undefined) };
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn((next) => next), disconnect: vi.fn() }));
  createGain = vi.fn(() => ({
    gain: { value: 1 },
    connect: vi.fn((next) => next),
    disconnect: vi.fn(),
  }));
  resume = vi.fn(async () => undefined);
  close = vi.fn(async () => {
    this.state = "closed";
  });
}

class FakeAudioWorkletNode {
  static last: FakeAudioWorkletNode;
  port: {
    onmessage: ((event: MessageEvent) => void) | null;
    postMessage: ReturnType<typeof vi.fn>;
  };
  private listeners = new Map<string, () => void>();

  constructor() {
    FakeAudioWorkletNode.last = this;
    this.port = {
      onmessage: null,
      postMessage: vi.fn((message: { type?: string }) => {
        if (message.type === "stop")
          queueMicrotask(() =>
            this.port.onmessage?.({ data: { type: "stopped" } } as MessageEvent),
          );
      }),
    };
  }

  connect(next: unknown) {
    return next;
  }

  disconnect = vi.fn();

  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, listener);
  }
}

describe("InterviewAudioCapture", () => {
  beforeEach(() => vi.stubGlobal("window", { location: { href: "http://localhost/" } }));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("converts worklet packets into ordered binary PCM frames and releases capture on stop", async () => {
    const videoTrack = { stop: vi.fn(), addEventListener: vi.fn() };
    const audioTrack = { stop: vi.fn(), addEventListener: vi.fn() };
    const stream = {
      getAudioTracks: () => [audioTrack],
      getVideoTracks: () => [videoTrack],
      getTracks: () => [audioTrack, videoTrack],
    };
    const getDisplayMedia = vi.fn(async () => stream);
    vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia } });
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);

    let deliverCredit: ((credit: { sessionId: string; count: number }) => void) | undefined;
    const bridge = {
      startInterview: vi.fn(async () => ({ sessionId: "capture-1" })),
      markInterviewCaptureReady: vi.fn(async () => undefined),
      failInterviewCapture: vi.fn(async () => undefined),
      stopInterview: vi.fn(async () => undefined),
      sendInterviewPcmFrame: vi.fn(),
      onInterviewAudioCredit: vi.fn(
        (listener: (credit: { sessionId: string; count: number }) => void) => {
          deliverCredit = listener;
          return vi.fn();
        },
      ),
    };
    const capture = new InterviewAudioCapture(bridge as never);

    await capture.start();
    expect(bridge.startInterview).toHaveBeenCalledWith(ActiveInterviewConversationId);
    expect(getDisplayMedia).toHaveBeenCalledWith({ audio: true, video: true });
    expect(videoTrack.stop).toHaveBeenCalledOnce();
    expect(bridge.markInterviewCaptureReady).toHaveBeenCalledWith("capture-1");

    const first = new Int16Array(1_600).buffer;
    FakeAudioWorkletNode.last.port.onmessage?.({
      data: { type: "frame", sequence: 0, startSample: 0, pcm: first },
    } as MessageEvent);
    const final = new Int16Array(800).buffer;
    FakeAudioWorkletNode.last.port.onmessage?.({
      data: { type: "frame", sequence: 1, startSample: 1_600, pcm: final },
    } as MessageEvent);

    expect(bridge.sendInterviewPcmFrame).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sequence: 0, startSample: 0, pcm: expect.any(Uint8Array) }),
    );
    expect(bridge.sendInterviewPcmFrame).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sequence: 1, startSample: 1_600 }),
    );
    for (let sequence = 2; sequence < 10; sequence += 1) {
      FakeAudioWorkletNode.last.port.onmessage?.({
        data: {
          type: "frame",
          sequence,
          startSample: sequence * 1_600,
          pcm: first,
        },
      } as MessageEvent);
    }
    expect(bridge.sendInterviewPcmFrame).toHaveBeenCalledTimes(10);
    deliverCredit?.({ sessionId: "capture-1", count: 5 });
    expect(capture.getState()).toEqual({ phase: "listening", agentConfirmedFrames: 5 });
    FakeAudioWorkletNode.last.port.onmessage?.({
      data: { type: "frame", sequence: 10, startSample: 16_000, pcm: first },
    } as MessageEvent);
    expect(bridge.sendInterviewPcmFrame).toHaveBeenCalledTimes(11);
    expect(capture.getState()).toEqual({ phase: "listening", agentConfirmedFrames: 5 });

    await capture.stop();
    expect(audioTrack.stop).toHaveBeenCalledOnce();
    expect(bridge.stopInterview).toHaveBeenCalledWith("capture-1");
    expect(capture.getState()).toEqual({ phase: "idle" });
  });

  it("fails the Agent session and releases Web Audio when display capture is denied", async () => {
    const denied = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    vi.stubGlobal("navigator", {
      mediaDevices: { getDisplayMedia: vi.fn(() => Promise.reject(denied)) },
    });
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
    const bridge = {
      startInterview: vi.fn(async () => ({ sessionId: "capture-2" })),
      markInterviewCaptureReady: vi.fn(async () => undefined),
      failInterviewCapture: vi.fn(async () => undefined),
      sendInterviewPcmFrame: vi.fn(),
    };
    const capture = new InterviewAudioCapture(bridge as never);

    await capture.start();

    expect(bridge.failInterviewCapture).toHaveBeenCalledWith("capture-2");
    expect(capture.getState()).toEqual({ phase: "error", message: "系统声音采集权限已取消" });
  });

  it("stops tracks if a display stream resolves after the user stopped during startup", async () => {
    let resolveDisplay: ((stream: MediaStream) => void) | undefined;
    const getDisplayMedia = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveDisplay = resolve;
        }),
    );
    vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia } });
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
    const bridge = {
      startInterview: vi.fn(async () => ({ sessionId: "capture-3" })),
      markInterviewCaptureReady: vi.fn(async () => undefined),
      failInterviewCapture: vi.fn(async () => undefined),
      stopInterview: vi.fn(async () => undefined),
      sendInterviewPcmFrame: vi.fn(),
    };
    const capture = new InterviewAudioCapture(bridge as never);

    const start = capture.start();
    await Promise.resolve();
    const stop = capture.stop();
    expect(capture.getState()).toEqual({ phase: "stopping" });
    const audioTrack = { stop: vi.fn(), addEventListener: vi.fn() };
    const videoTrack = { stop: vi.fn(), addEventListener: vi.fn() };
    const stream = {
      getAudioTracks: () => [audioTrack],
      getVideoTracks: () => [videoTrack],
      getTracks: () => [audioTrack, videoTrack],
    } as unknown as MediaStream;
    resolveDisplay?.(stream);
    await stop;
    await start;

    expect(bridge.stopInterview).toHaveBeenCalledWith("capture-3");
    expect(audioTrack.stop).toHaveBeenCalledOnce();
    expect(videoTrack.stop).toHaveBeenCalledOnce();
    expect(bridge.markInterviewCaptureReady).not.toHaveBeenCalled();
    expect(bridge.sendInterviewPcmFrame).not.toHaveBeenCalled();
  });

  it("fails and releases capture when the Agent stops returning credits", async () => {
    vi.useFakeTimers();
    const audioTrack = { stop: vi.fn(), addEventListener: vi.fn() };
    const stream = {
      getAudioTracks: () => [audioTrack],
      getVideoTracks: () => [],
      getTracks: () => [audioTrack],
    };
    vi.stubGlobal("navigator", {
      mediaDevices: { getDisplayMedia: vi.fn(async () => stream) },
    });
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
    const bridge = {
      startInterview: vi.fn(async () => ({ sessionId: "capture-4" })),
      markInterviewCaptureReady: vi.fn(async () => undefined),
      failInterviewCapture: vi.fn(async () => undefined),
      sendInterviewPcmFrame: vi.fn(),
      onInterviewAudioCredit: vi.fn(() => vi.fn()),
    };
    const capture = new InterviewAudioCapture(bridge as never);

    await capture.start();
    const pcm = new Int16Array(1_600).buffer;
    for (let sequence = 0; sequence < 10; sequence += 1) {
      FakeAudioWorkletNode.last.port.onmessage?.({
        data: { type: "frame", sequence, startSample: sequence * 1_600, pcm },
      } as MessageEvent);
    }
    await vi.advanceTimersByTimeAsync(3_000);

    expect(capture.getState()).toEqual({ phase: "error", message: "系统声音采集已中断" });
    expect(audioTrack.stop).toHaveBeenCalledOnce();
    expect(bridge.failInterviewCapture).toHaveBeenCalledWith("capture-4");
  });
});
