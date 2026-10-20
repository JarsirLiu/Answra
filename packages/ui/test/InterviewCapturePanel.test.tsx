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
    expect(screen.getByText("当前仅采集系统声音，转录和回答尚未接入。")).toBeInTheDocument();
  });

  it("shows Agent-confirmed audio frames as capture evidence", () => {
    render(
      <InterviewCapturePanel
        capture={capturePort()}
        state={{ phase: "listening", agentConfirmedFrames: 25 }}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("Agent 已确认接收 25 帧 PCM 音频。")).toBeInTheDocument();
  });
});
