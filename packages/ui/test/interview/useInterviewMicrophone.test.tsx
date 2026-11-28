import type { DesktopBridge } from "@answra/shared";
import { ActiveInterviewIntakeConversationId, INTERVIEW_AUDIO_CREDIT_WINDOW } from "@answra/shared";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useInterviewMicrophone } from "../../src/interview/voice/useInterviewMicrophone";

class FakePort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  postMessage = vi.fn();

  emit(message: unknown): void {
    this.onmessage?.({ data: message } as MessageEvent);
  }
}

class FakeNode {
  port = new FakePort();
  connect = vi.fn((target: unknown) => target);
  disconnect = vi.fn();

  addEventListener(): void {}
  removeEventListener(): void {}
}

const worklets: FakeNode[] = [];

class FakeAudioWorkletNode extends FakeNode {
  constructor(
    readonly context: unknown,
    readonly name: string,
    readonly options: unknown,
  ) {
    super();
    worklets.push(this);
  }
}

class FakeAudioContext {
  readonly sampleRate = 48_000;
  state = "running";
  destination = new FakeNode();
  audioWorklet = { addModule: vi.fn(async () => undefined) };
  createMediaStreamSource = vi.fn(() => new FakeNode());
  createGain = vi.fn(() => Object.assign(new FakeNode(), { gain: { value: 1 } }));
  resume = vi.fn(async () => undefined);
  close = vi.fn(async () => {
    this.state = "closed";
  });
}

const contexts: FakeAudioContext[] = [];

function fakeStream() {
  const track = { stop: vi.fn(), addEventListener: vi.fn() };
  return {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
}

function createBridge() {
  return {
    startInterview: vi.fn(async () => ({ sessionId: "session-1" })),
    markInterviewCaptureReady: vi.fn(async () => undefined),
    failInterviewCapture: vi.fn(async () => undefined),
    stopInterview: vi.fn(async () => undefined),
    sendInterviewPcmFrame: vi.fn(),
    onInterviewAudioCredit: vi.fn(() => () => undefined),
  } as unknown as DesktopBridge & {
    startInterview: ReturnType<typeof vi.fn>;
    markInterviewCaptureReady: ReturnType<typeof vi.fn>;
    failInterviewCapture: ReturnType<typeof vi.fn>;
    stopInterview: ReturnType<typeof vi.fn>;
    sendInterviewPcmFrame: ReturnType<typeof vi.fn>;
    onInterviewAudioCredit: ReturnType<typeof vi.fn>;
  };
}

describe("useInterviewMicrophone", () => {
  let getUserMedia: ReturnType<typeof vi.fn>;
  let originalAudioContext: unknown;
  let originalAudioWorkletNode: unknown;
  let originalMediaDevices: unknown;

  beforeEach(() => {
    worklets.length = 0;
    contexts.length = 0;
    getUserMedia = vi.fn(async () => fakeStream());
    originalAudioContext = Object.getOwnPropertyDescriptor(globalThis, "AudioContext")?.value;
    originalAudioWorkletNode = Object.getOwnPropertyDescriptor(
      globalThis,
      "AudioWorkletNode",
    )?.value;
    originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices")?.value;
    Object.defineProperty(globalThis, "AudioContext", {
      configurable: true,
      value: class extends FakeAudioContext {
        constructor() {
          super();
          contexts.push(this);
        }
      },
    });
    Object.defineProperty(globalThis, "AudioWorkletNode", {
      configurable: true,
      value: FakeAudioWorkletNode,
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "AudioContext", {
      configurable: true,
      value: originalAudioContext,
    });
    Object.defineProperty(globalThis, "AudioWorkletNode", {
      configurable: true,
      value: originalAudioWorkletNode,
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: originalMediaDevices,
    });
  });

  it("starts capture with the intake conversation and native device sample rate", async () => {
    const bridge = createBridge();
    const { result } = renderHook(() =>
      useInterviewMicrophone(bridge, ActiveInterviewIntakeConversationId),
    );

    await act(async () => {
      result.current.toggle();
    });

    await waitFor(() => expect(result.current.active).toBe(true));
    expect(bridge.startInterview).toHaveBeenCalledWith(ActiveInterviewIntakeConversationId);
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { autoGainControl: true, echoCancellation: true, noiseSuppression: true },
      video: false,
    });
    expect(bridge.markInterviewCaptureReady).toHaveBeenCalledWith("session-1");
    expect(worklets).toHaveLength(1);
    expect(worklets[0]?.port.postMessage).toHaveBeenCalledWith({
      type: "start",
      source: "candidate",
      sampleRate: 48_000,
      credits: INTERVIEW_AUDIO_CREDIT_WINDOW,
      maxCredits: INTERVIEW_AUDIO_CREDIT_WINDOW,
    });
  });

  it("forwards worklet frames and audio credits to the bridge", async () => {
    const bridge = createBridge();
    let creditListener: ((credit: { sessionId: string; count: number }) => void) | undefined;
    vi.mocked(bridge.onInterviewAudioCredit).mockImplementation((listener) => {
      creditListener = listener;
      return () => undefined;
    });
    const { result } = renderHook(() =>
      useInterviewMicrophone(bridge, ActiveInterviewIntakeConversationId),
    );

    await act(async () => {
      result.current.toggle();
    });
    await waitFor(() => expect(result.current.active).toBe(true));

    act(() => {
      worklets[0]?.port.emit({
        type: "frame",
        source: "candidate",
        sequence: 3,
        startSample: 3_200,
        pcm: new ArrayBuffer(3_200),
      });
    });
    expect(bridge.sendInterviewPcmFrame).toHaveBeenCalledWith({
      sessionId: "session-1",
      source: "candidate",
      sequence: 3,
      startSample: 3_200,
      sampleRate: 16_000,
      channels: 1,
      encoding: "pcm_s16le",
      pcm: expect.any(Uint8Array),
    });

    // 上一帧已消耗一个额度；credit 只补到窗口上限，不会无界堆积。
    act(() => {
      creditListener?.({ sessionId: "session-1", count: 2 });
    });
    expect(worklets[0]?.port.postMessage).toHaveBeenCalledWith({ type: "credit", count: 1 });
  });

  it("reports input level from the worklet", async () => {
    const bridge = createBridge();
    const { result } = renderHook(() =>
      useInterviewMicrophone(bridge, ActiveInterviewIntakeConversationId),
    );

    await act(async () => {
      result.current.toggle();
    });
    await waitFor(() => expect(result.current.active).toBe(true));

    act(() => {
      worklets[0]?.port.emit({ type: "level", level: 0.75 });
    });
    expect(result.current.level).toBe(0.75);
  });

  it("stops tracks, closes context and ends the agent session", async () => {
    const bridge = createBridge();
    const { result } = renderHook(() =>
      useInterviewMicrophone(bridge, ActiveInterviewIntakeConversationId),
    );

    await act(async () => {
      result.current.toggle();
    });
    await waitFor(() => expect(result.current.active).toBe(true));
    const stream = await getUserMedia.mock.results[0]?.value;

    await act(async () => {
      await result.current.stop();
    });

    expect(result.current.active).toBe(false);
    expect(bridge.stopInterview).toHaveBeenCalledWith("session-1");
    expect(stream).toBeDefined();
    expect(contexts[0]?.close).toHaveBeenCalled();
  });

  it("fails closed when microphone permission is denied", async () => {
    const bridge = createBridge();
    const denied = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    getUserMedia.mockRejectedValueOnce(denied);
    const { result } = renderHook(() =>
      useInterviewMicrophone(bridge, ActiveInterviewIntakeConversationId),
    );

    await act(async () => {
      result.current.toggle();
    });

    await waitFor(() => expect(result.current.error).toContain("麦克风权限被拒绝"));
    expect(bridge.failInterviewCapture).toHaveBeenCalledWith("session-1");
    expect(bridge.markInterviewCaptureReady).not.toHaveBeenCalled();
  });

  it("refuses to start when the bridge has no voice methods", async () => {
    const { result } = renderHook(() =>
      useInterviewMicrophone(undefined, ActiveInterviewIntakeConversationId),
    );

    await act(async () => {
      result.current.toggle();
    });

    expect(result.current.error).toBe("当前版本不支持语音输入");
    expect(getUserMedia).not.toHaveBeenCalled();
  });
});
