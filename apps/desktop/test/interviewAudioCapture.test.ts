import { ActiveInterviewConversationId } from "@answra/shared";
import { INTERVIEW_INPUT_LEVEL_WINDOW } from "@answra/ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INTERVIEW_INPUT_LEVEL_SAMPLE_MS,
  InterviewAudioCapture,
} from "../src/renderer/interviewAudioCapture";

class FakeAudioContext {
  state = "running";
  sampleRate = 16_000;
  destination = {};
  audioWorklet = { addModule: vi.fn(async () => undefined) };
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn((next) => next), disconnect: vi.fn() }));
  createAnalyser = vi.fn(() => ({
    fftSize: 0,
    smoothingTimeConstant: 0,
    connect: vi.fn((next) => next),
    getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0.05),
    disconnect: vi.fn(),
  }));
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
  static all: FakeAudioWorkletNode[] = [];
  port: {
    onmessage: ((event: MessageEvent) => void) | null;
    postMessage: ReturnType<typeof vi.fn>;
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
  };
  private listeners = new Map<string, (event: MessageEvent) => void>();

  constructor() {
    FakeAudioWorkletNode.all.push(this);
    this.port = {
      onmessage: null,
      addEventListener: vi.fn((type: string, listener: (event: MessageEvent) => void) =>
        this.listeners.set(type, listener),
      ),
      removeEventListener: vi.fn((type: string) => this.listeners.delete(type)),
      postMessage: vi.fn((message: { type?: string }) => {
        if (message.type === "stop") {
          const event = { data: { type: "stopped" } } as MessageEvent;
          queueMicrotask(() => {
            this.port.onmessage?.(event);
            this.listeners.get("message")?.(event);
          });
        }
      }),
    };
  }

  connect(next: unknown) {
    return next;
  }

  disconnect = vi.fn();
  addEventListener() {}
}

describe("InterviewAudioCapture", () => {
  beforeEach(() => {
    FakeAudioWorkletNode.all = [];
    vi.stubGlobal("window", { location: { href: "http://localhost/" } });
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("sends microphone PCM and publishes sampled input levels until stop", async () => {
    vi.useFakeTimers();
    const track = { stop: vi.fn(), addEventListener: vi.fn() };
    const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
    const getUserMedia = vi.fn(async () => stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    let deliverCredit: ((credit: { sessionId: string; count: number }) => void) | undefined;
    const bridge = {
      startInterview: vi.fn(async () => ({ sessionId: "capture-1" })),
      markInterviewCaptureReady: vi.fn(async () => undefined),
      stopInterview: vi.fn(async () => undefined),
      failInterviewCapture: vi.fn(async () => undefined),
      sendInterviewPcmFrame: vi.fn(),
      onInterviewAudioCredit: vi.fn((listener) => {
        deliverCredit = listener;
        return vi.fn();
      }),
    };
    const capture = new InterviewAudioCapture(bridge as never);

    await capture.start();
    expect(bridge.startInterview).toHaveBeenCalledWith(ActiveInterviewConversationId);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(FakeAudioWorkletNode.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(40);
    expect(capture.getState().inputLevels?.at(-1)).toBeGreaterThan(0);

    // 电平窗口滚动到上限后丢弃最旧样本，保持与 INTERVIEW_INPUT_LEVEL_WINDOW 一致
    await vi.advanceTimersByTimeAsync(
      INTERVIEW_INPUT_LEVEL_SAMPLE_MS * INTERVIEW_INPUT_LEVEL_WINDOW,
    );
    expect(capture.getState().inputLevels).toHaveLength(INTERVIEW_INPUT_LEVEL_WINDOW);

    FakeAudioWorkletNode.all[0]?.port.onmessage?.({
      data: {
        type: "frame",
        source: "candidate",
        sequence: 0,
        startSample: 0,
        pcm: new ArrayBuffer(3_200),
      },
    } as MessageEvent);
    expect(bridge.sendInterviewPcmFrame).toHaveBeenCalledWith(
      expect.objectContaining({ source: "candidate", sequence: 0, pcm: expect.any(Uint8Array) }),
    );
    deliverCredit?.({ sessionId: "capture-1", count: 1 });

    await capture.stop();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(bridge.stopInterview).toHaveBeenCalledWith("capture-1");
    // 精确断言：停止后的状态只包含可见面（采集态 + 电平），不让旧转录面残留。
    expect(capture.getState()).toEqual({ phase: "idle", inputLevels: [] });
  });

  it("reports microphone permission denial without requesting system audio", async () => {
    const denied = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(() => Promise.reject(denied)) },
    });
    const bridge = {
      startInterview: vi.fn(async () => ({ sessionId: "capture-2" })),
      markInterviewCaptureReady: vi.fn(async () => undefined),
      failInterviewCapture: vi.fn(async () => undefined),
      sendInterviewPcmFrame: vi.fn(),
    };
    const capture = new InterviewAudioCapture(bridge as never);

    await capture.start();

    expect(capture.getState()).toMatchObject({
      phase: "error",
      message: "麦克风权限被拒绝或已取消，请检查 Windows 麦克风隐私设置",
    });
    expect(bridge.failInterviewCapture).toHaveBeenCalledWith("capture-2");
  });

  it("releases a microphone stream that resolves after startup was cancelled", async () => {
    let resolveStream: ((stream: MediaStream) => void) | undefined;
    const getUserMedia = vi.fn(
      () => new Promise<MediaStream>((resolve) => (resolveStream = resolve)),
    );
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const bridge = {
      startInterview: vi.fn(async () => ({ sessionId: "capture-3" })),
      markInterviewCaptureReady: vi.fn(async () => undefined),
      stopInterview: vi.fn(async () => undefined),
      failInterviewCapture: vi.fn(async () => undefined),
      sendInterviewPcmFrame: vi.fn(),
    };
    const capture = new InterviewAudioCapture(bridge as never);

    const starting = capture.start();
    await Promise.resolve();
    const stopping = capture.stop();
    const track = { stop: vi.fn(), addEventListener: vi.fn() };
    resolveStream?.({
      getTracks: () => [track],
      getAudioTracks: () => [track],
    } as unknown as MediaStream);
    await Promise.all([starting, stopping]);

    expect(track.stop).toHaveBeenCalledOnce();
    expect(bridge.markInterviewCaptureReady).not.toHaveBeenCalled();
    expect(bridge.stopInterview).toHaveBeenCalledWith("capture-3");
  });
});
