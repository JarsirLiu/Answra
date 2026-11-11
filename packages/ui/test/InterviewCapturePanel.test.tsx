import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("InterviewCapturePanel", () => {
  it("keeps one entry point and one explainer, with no header context while idle", () => {
    render(
      <InterviewCapturePanel
        capture={capturePort()}
        state={{ phase: "idle" }}
        messages={[]}
        onSendText={vi.fn(async () => undefined)}
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("region", { name: "面试演练" }).querySelector(".panel-context"),
    ).toBeNull();
    expect(screen.queryAllByText("正在监听麦克风")).toHaveLength(0);
    expect(screen.getByText("先让我检查你的面试记忆和简历，再开始演练。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始演练麦克风监听" })).toBeInTheDocument();
  });

  it("starts rehearsal from the empty state and disables the action while pending", async () => {
    const pending = deferred();
    const onStartRehearsal = vi.fn(() => pending.promise);
    render(
      <InterviewCapturePanel
        capture={capturePort()}
        state={{ phase: "idle" }}
        messages={[]}
        onSendText={vi.fn(async () => undefined)}
        onStartRehearsal={onStartRehearsal}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "开始面试演练" }));

    expect(onStartRehearsal).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "正在开始…" })).toBeDisabled();

    pending.resolve();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "开始面试演练" })).not.toBeDisabled(),
    );
  });

  it("appends manual input as a user message", async () => {
    const onSendText = vi.fn(async () => undefined);
    render(
      <InterviewCapturePanel
        capture={capturePort()}
        state={{ phase: "idle" }}
        messages={[]}
        onSendText={onSendText}
        onClose={vi.fn()}
      />,
    );

    const input = screen.getByRole("textbox", { name: "演练消息" });
    fireEvent.change(input, { target: { value: "手动补充内容" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    expect(onSendText).toHaveBeenCalledWith("手动补充内容");
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("clears the draft only after the user message is appended", async () => {
    const append = deferred();
    render(
      <InterviewCapturePanel
        capture={capturePort()}
        state={{ phase: "idle" }}
        messages={[]}
        onSendText={() => append.promise}
        onClose={vi.fn()}
      />,
    );

    const input = screen.getByRole("textbox", { name: "演练消息" });
    fireEvent.change(input, { target: { value: "手动补充内容" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    expect(input).toHaveValue("手动补充内容");
    append.resolve();
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("keeps the draft when the append fails", async () => {
    const onSendText = vi.fn(async () => {
      throw new Error("当前回复尚未完成");
    });
    render(
      <InterviewCapturePanel
        capture={capturePort()}
        state={{ phase: "idle" }}
        messages={[]}
        onSendText={onSendText}
        onClose={vi.fn()}
      />,
    );

    const input = screen.getByRole("textbox", { name: "演练消息" });
    fireEvent.change(input, { target: { value: "手动补充内容" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    await waitFor(() => expect(onSendText).toHaveBeenCalledWith("手动补充内容"));
    expect(input).toHaveValue("手动补充内容");
  });

  it("replaces send with cancel while an assistant reply is streaming", () => {
    const onCancel = vi.fn();
    render(
      <InterviewCapturePanel
        capture={capturePort()}
        state={{ phase: "idle" }}
        messages={[
          { id: "user-1", role: "user", text: "请自我介绍", status: "complete" },
          { id: "run-1", role: "assistant", text: "正在回答", status: "streaming" },
        ]}
        onSendText={vi.fn(async () => undefined)}
        onCancel={onCancel}
        onClose={vi.fn()}
      />,
    );

    const input = screen.getByRole("textbox", { name: "演练消息" });
    fireEvent.change(input, { target: { value: "补充内容" } });
    expect(screen.queryByRole("button", { name: "发送消息" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "停止回复" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(input).not.toBeDisabled();
    expect(input).toHaveValue("补充内容");
  });

  it("replaces the editor with mic levels and a single status row while listening", () => {
    render(
      <InterviewCapturePanel
        capture={capturePort()}
        state={{ phase: "listening", inputLevels: [0.05, 0.8, 0.2] }}
        messages={[
          { id: "message-1", role: "user", text: "语音转成的用户消息", status: "complete" },
        ]}
        onSendText={vi.fn(async () => undefined)}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getAllByText("正在监听麦克风")).toHaveLength(1);
    expect(screen.queryByRole("textbox", { name: "演练消息" })).not.toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "切换到打字" })).toBeInTheDocument();
  });

  it("returns to the text editor after switching off voice capture", () => {
    const capture = capturePort();
    const { rerender } = render(
      <InterviewCapturePanel
        capture={capture}
        state={{ phase: "listening", inputLevels: [] }}
        messages={[{ id: "message-1", role: "user", text: "语音消息", status: "complete" }]}
        onSendText={vi.fn(async () => undefined)}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "切换到打字" }));

    expect(capture.stop).toHaveBeenCalledTimes(1);

    rerender(
      <InterviewCapturePanel
        capture={capture}
        state={{ phase: "idle" }}
        messages={[{ id: "message-1", role: "user", text: "语音消息", status: "complete" }]}
        onSendText={vi.fn(async () => undefined)}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("textbox", { name: "演练消息" })).toBeInTheDocument();
  });

  it("renders interrupted replies as ordinary finished content without a status label", () => {
    render(
      <InterviewCapturePanel
        capture={capturePort()}
        state={{ phase: "listening", inputLevels: [] }}
        messages={[
          { id: "user-1", role: "user", text: "请自我介绍", status: "complete" },
          { id: "run-1", role: "assistant", text: "我先说说经历", status: "streaming" },
          { id: "run-2", role: "assistant", text: "上一轮回答", status: "interrupted" },
        ]}
        onSendText={vi.fn(async () => undefined)}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("请自我介绍").closest("article")).toHaveClass("chat-message--user");
    expect(screen.getByText("我先说说经历").closest("article")).toHaveClass(
      "chat-message--assistant",
    );
    expect(screen.getByText("上一轮回答").closest("article")).not.toHaveTextContent("已中断");
  });

  it("omits an empty interrupted assistant message", () => {
    render(
      <InterviewCapturePanel
        capture={capturePort()}
        state={{ phase: "listening", inputLevels: [] }}
        messages={[{ id: "run-1", role: "assistant", text: "", status: "interrupted" }]}
        onSendText={vi.fn(async () => undefined)}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(screen.getByText("回答会加入对话，面试官会继续追问。")).toBeInTheDocument();
  });

  it("renders assistant markdown through the shared message component", () => {
    render(
      <InterviewCapturePanel
        capture={capturePort()}
        state={{ phase: "idle" }}
        messages={[
          {
            id: "run-1",
            role: "assistant",
            text: "**重点**\n\n- 第一条",
            status: "complete",
          },
        ]}
        onSendText={vi.fn(async () => undefined)}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("重点").tagName).toBe("STRONG");
    expect(screen.getByText("第一条").closest("li")).not.toBeNull();
  });

  it("shows the retry attempt in place without adding a message", () => {
    const { rerender } = render(
      <InterviewCapturePanel
        capture={capturePort()}
        state={{ phase: "idle" }}
        messages={[{ id: "run-1", role: "assistant", text: "", status: "streaming" }]}
        retry={{ kind: "rate-limit", attempt: 1, maxRetries: 5 }}
        onSendText={vi.fn(async () => undefined)}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("请求触发限流，正在等待后重试 1/5");
    expect(screen.getAllByRole("article")).toHaveLength(1);

    rerender(
      <InterviewCapturePanel
        capture={capturePort()}
        state={{ phase: "idle" }}
        messages={[{ id: "run-1", role: "assistant", text: "", status: "streaming" }]}
        retry={{ kind: "rate-limit", attempt: 2, maxRetries: 5 }}
        onSendText={vi.fn(async () => undefined)}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("请求触发限流，正在等待后重试 2/5");
    expect(screen.getAllByRole("article")).toHaveLength(1);
  });

  it("shows a settled retry record with the failure alert after an abnormal end", () => {
    render(
      <InterviewCapturePanel
        capture={capturePort()}
        state={{ phase: "idle" }}
        messages={[{ id: "run-1", role: "assistant", text: "", status: "failed" }]}
        retry={{ kind: "rate-limit", attempt: 5, maxRetries: 5, finished: true }}
        error="inference exceeds tpm/rpm limit"
        onSendText={vi.fn(async () => undefined)}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("status", { name: "重试已结束" })).toBeInTheDocument();
    expect(screen.queryByText("限流重试结束，本轮异常终止 5/5")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("inference exceeds tpm/rpm limit");
    expect(screen.getAllByRole("article")).toHaveLength(1);
  });

  it("maps the capture failure phase to a status alert", () => {
    render(
      <InterviewCapturePanel
        capture={capturePort()}
        state={{ phase: "error", message: "麦克风权限被拒绝" }}
        messages={[]}
        onSendText={vi.fn(async () => undefined)}
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
        messages={[{ id: "message-1", role: "user", text: "已保存的一条", status: "complete" }]}
        error="消息发送失败"
        onSendText={vi.fn(async () => undefined)}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("消息发送失败");
    expect(
      screen.queryByText("点击麦克风用语音回答，或直接输入文字开始演练。"),
    ).not.toBeInTheDocument();
  });

  it("renders compact tool rows from assistant message parts", () => {
    render(
      <InterviewCapturePanel
        capture={capturePort()}
        state={{ phase: "idle" }}
        messages={[
          {
            id: "run-1",
            role: "assistant",
            text: "",
            status: "complete",
            parts: [
              {
                id: "tool-1",
                kind: "tool",
                toolCallId: "tool-1",
                toolName: "Read",
                state: "completed",
                input: { file_path: "src/a.ts" },
              },
            ],
          },
        ]}
        onSendText={vi.fn(async () => undefined)}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("Read")).toBeInTheDocument();
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.queryByText("完成")).toBeNull();
  });
});
