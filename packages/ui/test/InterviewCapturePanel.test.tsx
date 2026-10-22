import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { InterviewCapturePort } from "../src/app/interviewCapture";
import { INTERVIEW_INPUT_LEVEL_WINDOW } from "../src/app/interviewCapture";
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
  it("keeps one entry point and one explainer, with no header context while idle", () => {
    render(
      <InterviewCapturePanel
        capture={capturePort()}
        state={{ phase: "idle" }}
        messages={[]}
        onSendText={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("region", { name: "面试对话" }).querySelector(".panel-context"),
    ).toBeNull();
    expect(screen.queryAllByText("正在监听麦克风")).toHaveLength(0);
    expect(screen.getByText("点击下方麦克风开始语音输入。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始麦克风监听" })).toBeInTheDocument();
  });

  it("appends manual input as a user message", () => {
    const onSendText = vi.fn();
    render(
      <InterviewCapturePanel
        capture={capturePort()}
        state={{ phase: "idle" }}
        messages={[]}
        onSendText={onSendText}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "面试消息" }), {
      target: { value: "手动补充内容" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    expect(onSendText).toHaveBeenCalledWith("手动补充内容");
  });

  it("replaces the editor with mic levels and a single status row while listening", () => {
    render(
      <InterviewCapturePanel
        capture={capturePort()}
        state={{ phase: "listening", inputLevels: [0.05, 0.8, 0.2] }}
        messages={[{ id: "message-1", content: "语音转成的用户消息" }]}
        onSendText={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getAllByText("正在监听麦克风")).toHaveLength(1);
    expect(screen.queryByRole("textbox", { name: "面试消息" })).not.toBeInTheDocument();
    const wave = screen.getByRole("img", { name: "麦克风实时音量" });
    // 窗口不足时以静默槽位补齐，波形槽位恒定并铺满输入区
    expect(wave.children).toHaveLength(INTERVIEW_INPUT_LEVEL_WINDOW);
    const bars = [...wave.children] as HTMLElement[];
    expect(bars.at(0)?.style.height).toBe("0%");
    expect(bars.at(-1)?.style.height).toBe("20%");
    expect(screen.getByText("语音转成的用户消息").closest("article")).toHaveClass(
      "chat-message--user",
    );
    expect(screen.getByRole("button", { name: "停止语音输入" })).toBeInTheDocument();
  });

  it("maps the capture failure phase to a status alert", () => {
    render(
      <InterviewCapturePanel
        capture={capturePort()}
        state={{ phase: "error", message: "麦克风权限被拒绝" }}
        messages={[]}
        onSendText={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getAllByText("麦克风权限被拒绝")).toHaveLength(1);
  });

  it("shows the append failure through the shared alert notice", () => {
    render(
      <InterviewCapturePanel
        capture={capturePort()}
        state={{ phase: "idle" }}
        messages={[{ id: "message-1", content: "已保存的一条" }]}
        error="消息发送失败"
        onSendText={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("消息发送失败");
    expect(screen.queryByText("点击下方麦克风开始语音输入。")).not.toBeInTheDocument();
  });
});
