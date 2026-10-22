import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { InterviewCapturePort } from "../src/app/interviewCapture";
import { InterviewCapturePanel } from "../src/components/panels/InterviewCapturePanel";

function capturePort(): InterviewCapturePort {
  return {
    getState: () => ({ phase: "idle" }),
    subscribe: () => () => undefined,
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
}

describe("InterviewCapturePanel", () => {
  it("allows cancelling startup and stops a ready capture", () => {
    const capture = capturePort();
    const { rerender } = render(
      <InterviewCapturePanel capture={capture} state={{ phase: "idle" }} onClose={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "开始采集" }));
    expect(capture.start).toHaveBeenCalledOnce();

    rerender(
      <InterviewCapturePanel capture={capture} state={{ phase: "starting" }} onClose={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "停止采集" })).toBeEnabled();

    rerender(
      <InterviewCapturePanel capture={capture} state={{ phase: "listening" }} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "停止采集" }));
    expect(capture.stop).toHaveBeenCalledOnce();
    expect(
      screen.getByText("音频已送达识别链路；转写文字会在语音片段结束后显示。"),
    ).toBeInTheDocument();
  });

  it("shows transcripts with speaker and interviewer turn-end status", () => {
    render(
      <InterviewCapturePanel
        capture={capturePort()}
        state={{
          phase: "listening",
          transcripts: [
            {
              id: "question:0",
              speaker: "interviewer",
              text: "请介绍一下自己",
              turnEnd: true,
              timestamp: 1000,
            },
            { id: "answer:0", speaker: "user", text: "我叫小王", turnEnd: true, timestamp: 2000 },
          ],
        }}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("请介绍一下自己")).toBeInTheDocument();
    expect(screen.getByText("我叫小王")).toBeInTheDocument();
    expect(screen.getByText("对方")).toBeInTheDocument();
    expect(screen.getByText("我")).toBeInTheDocument();
    expect(screen.getByText("检测到对方停顿")).toBeInTheDocument();
  });

  it("explains that listening status confirms audio delivery, not completed transcription", () => {
    render(
      <InterviewCapturePanel
        capture={capturePort()}
        state={{ phase: "listening", agentConfirmedFrames: 25 }}
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByText("音频已送达识别链路；转写文字会在语音片段结束后显示。"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/帧 PCM 音频/)).not.toBeInTheDocument();
  });
});
