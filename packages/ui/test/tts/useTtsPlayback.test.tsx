import type { DesktopBridge, TtsAudioFrame, TtsFailureEvent, TtsStopPayload } from "@answra/shared";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { type PlayableAudio, useTtsPlayback } from "../../src/tts/useTtsPlayback";

class FakeAudio implements PlayableAudio {
  onended: ((event: Event) => void) | null = null;
  onerror: ((event: Event | string) => void) | null = null;
  readonly play = vi.fn(async () => undefined);
  readonly pause = vi.fn();

  constructor(readonly url: string) {}

  end(): void {
    this.onended?.(new Event("ended"));
  }
}

function createBridge() {
  const listeners: {
    audio?: (frame: TtsAudioFrame) => void;
    stopped?: (payload: TtsStopPayload) => void;
    failed?: (event: TtsFailureEvent) => void;
  } = {};
  const bridge: DesktopBridge = {
    fitContent: vi.fn(),
    close: vi.fn(),
    onTtsAudio: (listener) => {
      listeners.audio = listener;
      return () => undefined;
    },
    onTtsStopped: (listener) => {
      listeners.stopped = listener;
      return () => undefined;
    },
    onTtsFailed: (listener) => {
      listeners.failed = listener;
      return () => undefined;
    },
  };
  return { bridge, listeners };
}

function frame(overrides: Partial<TtsAudioFrame> = {}): TtsAudioFrame {
  return {
    messageId: "message-1",
    conversationId: "conversation-1",
    source: "auto",
    sequence: 0,
    mimeType: "audio/mpeg",
    bytes: Uint8Array.of(1, 2),
    ...overrides,
  };
}

function Harness({ bridge, created }: { bridge: DesktopBridge; created: FakeAudio[] }) {
  const tts = useTtsPlayback(bridge, (url) => {
    const audio = new FakeAudio(url);
    created.push(audio);
    return audio;
  });
  return (
    <div>
      <span data-testid="failure">{tts.failure ?? ""}</span>
      <button onClick={tts.dismissFailure} type="button">
        dismiss
      </button>
    </div>
  );
}

describe("useTtsPlayback", () => {
  it("plays auto frames in order and skips a repeated messageId+sequence", () => {
    const { bridge, listeners } = createBridge();
    const created: FakeAudio[] = [];
    render(<Harness bridge={bridge} created={created} />);

    act(() => {
      listeners.audio?.(frame({ sequence: 0 }));
      listeners.audio?.(frame({ sequence: 0 }));
      listeners.audio?.(frame({ sequence: 1 }));
    });

    expect(created).toHaveLength(1);
    expect(created[0]?.play).toHaveBeenCalledOnce();

    act(() => created[0]?.end());
    expect(created).toHaveLength(2);
    expect(created[1]?.url).toBe("blob:exam-screenshot");
  });

  it("lets manual frames replay the same message", () => {
    const { bridge, listeners } = createBridge();
    const created: FakeAudio[] = [];
    render(<Harness bridge={bridge} created={created} />);

    act(() => listeners.audio?.(frame({ source: "manual" })));
    act(() => created[0]?.end());

    act(() => listeners.audio?.(frame({ source: "manual" })));
    expect(created).toHaveLength(2);
  });

  it("drops queued frames and pauses the active audio on stop", () => {
    const { bridge, listeners } = createBridge();
    const created: FakeAudio[] = [];
    render(<Harness bridge={bridge} created={created} />);

    act(() => {
      listeners.audio?.(frame({ sequence: 0 }));
      listeners.audio?.(frame({ sequence: 1 }));
    });
    expect(created).toHaveLength(1);

    act(() => listeners.stopped?.({ conversationId: "conversation-1" }));
    expect(created[0]?.pause).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:exam-screenshot");

    act(() => created[0]?.end());
    expect(created).toHaveLength(1);
  });

  it("shows a failure except when the code is aborted", () => {
    const { bridge, listeners } = createBridge();
    const created: FakeAudio[] = [];
    render(<Harness bridge={bridge} created={created} />);

    act(() =>
      listeners.failed?.({
        messageId: "m1",
        conversationId: "c1",
        failure: { code: "aborted", message: "已取消", retryable: false },
      }),
    );
    expect(screen.getByTestId("failure")).toHaveTextContent("");

    act(() =>
      listeners.failed?.({
        messageId: "m1",
        conversationId: "c1",
        failure: { code: "network", message: "无法连接语音合成服务。", retryable: true },
      }),
    );
    expect(screen.getByTestId("failure")).toHaveTextContent("无法连接语音合成服务。");
  });
});
