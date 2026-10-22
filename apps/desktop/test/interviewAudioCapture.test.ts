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
  static all: FakeAudioWorkletNode[] = [];
  port: {
    onmessage: ((event: MessageEvent) => void) | null;
    postMessage: ReturnType<typeof vi.fn>;
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
  };
  private listeners = new Map<string, () => void>();

  constructor() {
    FakeAudioWorkletNode.last = this;
    FakeAudioWorkletNode.all.push(this);
    this.port = {
      onmessage: null,
      addEventListener: vi.fn((type: string, listener: (event: MessageEvent) => void) => {
        if (type === "message") this.listeners.set(type, listener);
      }),
      removeEventListener: vi.fn((type: string) => this.listeners.delete(type)),
      postMessage: vi.fn((message: { type?: string }) => {
        if (message.type !== "stop") return;
        queueMicrotask(() => {
          const event = { data: { type: "stopped" } } as MessageEvent;
          this.port.onmessage?.(event);
          this.listeners.get("message")?.(event);
        });
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
  beforeEach(() => {
    FakeAudioWorkletNode.all = [];
    vi.stubGlobal("window", { location: { href: "http://localhost/" } });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("converts worklet packets into ordered binary PCM frames and releases capture on stop", async () => {
    const videoTrack = { stop: vi.fn(), addEventListener: vi.fn() };
    const audioTrack = { stop: vi.fn(), addEventListener: vi.fn() };
    const interviewerStream = {
      getAudioTracks: () => [audioTrack],
      getVideoTracks: () => [videoTrack],
      getTracks: () => [audioTrack, videoTrack],
    };
    const microphoneTrack = { stop: vi.fn(), addEventListener: vi.fn() };
    const microphoneStream = {
      getAudioTracks: () => [microphoneTrack],
      getVideoTracks: () => [],
      getTracks: () => [microphoneTrack],
    };
    const getDisplayMedia = vi.fn(async () => interviewerStream);
    const getUserMedia = vi.fn(async () => microphoneStream);
    vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia, getUserMedia } });
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
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(FakeAudioWorkletNode.all).toHaveLength(2);
    expect(videoTrack.stop).toHaveBeenCalledOnce();
    expect(bridge.markInterviewCaptureReady).toHaveBeenCalledWith("capture-1");

    const first = new Int16Array(1_600).buffer;
    const interviewerWorklet = FakeAudioWorkletNode.all[0];
    const candidateWorklet = FakeAudioWorkletNode.all[1];
    interviewerWorklet?.port.onmessage?.({
      data: { type: "frame", source: "interviewer", sequence: 0, startSample: 0, pcm: first },
    } as MessageEvent);
    const final = new Int16Array(800).buffer;
    candidateWorklet?.port.onmessage?.({
      data: { type: "frame", source: "candidate", sequence: 0, startSample: 0, pcm: final },
    } as MessageEvent);

    expect(bridge.sendInterviewPcmFrame).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        source: "interviewer",
        sequence: 0,
        startSample: 0,
        pcm: expect.any(Uint8Array),
      }),
    );
    expect(bridge.sendInterviewPcmFrame).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ source: "candidate", sequence: 0, startSample: 0 }),
    );
    for (let sequence = 2; sequence < 10; sequence += 1) {
      interviewerWorklet?.port.onmessage?.({
        data: {
          type: "frame",
          source: "interviewer",
          sequence,
          startSample: sequence * 1_600,
          pcm: first,
        },
      } as MessageEvent);
    }
    expect(bridge.sendInterviewPcmFrame).toHaveBeenCalledTimes(10);
    deliverCredit?.({ sessionId: "capture-1", count: 5 });
    expect(capture.getState()).toEqual({
      phase: "listening",
      agentConfirmedFrames: 5,
      transcripts: [],
    });
    interviewerWorklet?.port.onmessage?.({
      data: { type: "frame", source: "interviewer", sequence: 10, startSample: 16_000, pcm: first },
    } as MessageEvent);
    expect(bridge.sendInterviewPcmFrame).toHaveBeenCalledTimes(11);
    expect(capture.getState()).toEqual({
      phase: "listening",
      agentConfirmedFrames: 5,
      transcripts: [],
    });

    await capture.stop();
    expect(audioTrack.stop).toHaveBeenCalledOnce();
    expect(microphoneTrack.stop).toHaveBeenCalledOnce();
    expect(bridge.stopInterview).toHaveBeenCalledWith("capture-1");
    expect(capture.getState()).toEqual({ phase: "idle", transcripts: [] });
  });

  it("fails the Agent session and releases Web Audio when display capture is denied", async () => {
    const denied = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getDisplayMedia: vi.fn(() => Promise.reject(denied)),
        getUserMedia: vi.fn(async () => ({ getTracks: () => [], getAudioTracks: () => [] })),
      },
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
    expect(capture.getState()).toEqual({
      phase: "error",
      message: "系统声音捕获被拒绝或已取消，请重试系统音频捕获",
    });
  });

  it("identifies microphone permission denial separately from system audio denial", async () => {
    const denied = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    const interviewerTrack = { stop: vi.fn(), addEventListener: vi.fn() };
    const interviewerStream = {
      getAudioTracks: () => [interviewerTrack],
      getVideoTracks: () => [],
      getTracks: () => [interviewerTrack],
    };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getDisplayMedia: vi.fn(async () => interviewerStream),
        getUserMedia: vi.fn(() => Promise.reject(denied)),
      },
    });
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
    const bridge = {
      startInterview: vi.fn(async () => ({ sessionId: "capture-mic-denied" })),
      markInterviewCaptureReady: vi.fn(async () => undefined),
      failInterviewCapture: vi.fn(async () => undefined),
      sendInterviewPcmFrame: vi.fn(),
    };
    const capture = new InterviewAudioCapture(bridge as never);

    await capture.start();

    expect(capture.getState()).toEqual({
      phase: "error",
      message: "麦克风权限被拒绝或已取消，请检查 Windows 麦克风隐私设置",
    });
    expect(interviewerTrack.stop).toHaveBeenCalledOnce();
    expect(bridge.failInterviewCapture).toHaveBeenCalledWith("capture-mic-denied");
  });

  it("stops tracks if a display stream resolves after the user stopped during startup", async () => {
    let resolveDisplay: ((stream: MediaStream) => void) | undefined;
    const getDisplayMedia = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveDisplay = resolve;
        }),
    );
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [], getAudioTracks: () => [] }));
    vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia, getUserMedia } });
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
    const microphoneTrack = { stop: vi.fn(), addEventListener: vi.fn() };
    const interviewerStream = {
      getAudioTracks: () => [audioTrack],
      getVideoTracks: () => [],
      getTracks: () => [audioTrack],
    };
    const microphoneStream = {
      getAudioTracks: () => [microphoneTrack],
      getVideoTracks: () => [],
      getTracks: () => [microphoneTrack],
    };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getDisplayMedia: vi.fn(async () => interviewerStream),
        getUserMedia: vi.fn(async () => microphoneStream),
      },
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
      FakeAudioWorkletNode.all[0]?.port.onmessage?.({
        data: {
          type: "frame",
          source: "interviewer",
          sequence,
          startSample: sequence * 1_600,
          pcm,
        },
      } as MessageEvent);
    }
    await vi.advanceTimersByTimeAsync(3_000);

    expect(capture.getState()).toEqual({ phase: "error", message: "面试音频采集已中断" });
    expect(audioTrack.stop).toHaveBeenCalledOnce();
    expect(microphoneTrack.stop).toHaveBeenCalledOnce();
    expect(bridge.failInterviewCapture).toHaveBeenCalledWith("capture-4");
  });
});
