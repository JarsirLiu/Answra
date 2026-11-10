import { ActiveInterviewConversationId } from "@answra/shared";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FloatingBarApp } from "../src/app/FloatingBarApp";
import {
  conversationListeners,
  createConversationBridge,
  resetFloatingBarTestState,
} from "./support/floatingBarHarness";

describe("floating bar interview rehearsal", () => {
  beforeEach(resetFloatingBarTestState);

  it("starts rehearsal from the empty state by sending the fixed action message", async () => {
    const bridge = createConversationBridge();
    const capture = {
      getState: () => ({ phase: "idle" as const }),
      subscribe: () => () => undefined,
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    render(<FloatingBarApp bridge={bridge} interviewCapture={capture} />);
    fireEvent.click(screen.getByRole("button", { name: "对话" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "面试" }));
    fireEvent.click(screen.getByRole("button", { name: "面试演练" }));

    fireEvent.click(screen.getByRole("button", { name: "开始面试演练" }));

    await waitFor(() =>
      expect(bridge.sendInterviewMessage).toHaveBeenCalledWith(
        ActiveInterviewConversationId,
        expect.stringContaining("请先检查我的面试记忆和简历是否存在"),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "开始面试演练" })).not.toBeInTheDocument(),
    );
  });

  it("sends interview text through the interview message command", async () => {
    const bridge = createConversationBridge();
    const capture = {
      getState: () => ({ phase: "idle" as const }),
      subscribe: () => () => undefined,
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    render(<FloatingBarApp bridge={bridge} interviewCapture={capture} />);
    fireEvent.click(screen.getByRole("button", { name: "对话" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "面试" }));
    fireEvent.click(screen.getByRole("button", { name: "面试演练" }));
    fireEvent.change(screen.getByRole("textbox", { name: "演练消息" }), {
      target: { value: "只追加用户消息" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    await waitFor(() =>
      expect(bridge.sendInterviewMessage).toHaveBeenCalledWith(
        ActiveInterviewConversationId,
        "只追加用户消息",
      ),
    );
    expect(bridge.sendConversationMessage).not.toHaveBeenCalled();
    expect(await screen.findByText("只追加用户消息")).toHaveClass("message-content");
  });

  it("keeps the interview draft and shows the failure when the append is rejected", async () => {
    const bridge = createConversationBridge();
    bridge.sendInterviewMessage.mockRejectedValueOnce(new Error("当前回复尚未完成"));
    const capture = {
      getState: () => ({ phase: "idle" as const }),
      subscribe: () => () => undefined,
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    render(<FloatingBarApp bridge={bridge} interviewCapture={capture} />);
    fireEvent.click(screen.getByRole("button", { name: "对话" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "面试" }));
    fireEvent.click(screen.getByRole("button", { name: "面试演练" }));
    const input = screen.getByRole("textbox", { name: "演练消息" });
    fireEvent.change(input, { target: { value: "不能丢的草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("当前回复尚未完成"));
    expect(input).toHaveValue("不能丢的草稿");
  });

  it("clears a stale manual-send error when a new assistant reply starts", async () => {
    const bridge = createConversationBridge();
    bridge.sendInterviewMessage.mockRejectedValueOnce(new Error("当前回复尚未完成"));
    const capture = {
      getState: () => ({ phase: "idle" as const }),
      subscribe: () => () => undefined,
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    render(<FloatingBarApp bridge={bridge} interviewCapture={capture} />);
    fireEvent.click(screen.getByRole("button", { name: "对话" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "面试" }));
    fireEvent.click(screen.getByRole("button", { name: "面试演练" }));
    const input = screen.getByRole("textbox", { name: "演练消息" });
    fireEvent.change(input, { target: { value: "不能丢的草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("当前回复尚未完成"));

    act(() => {
      for (const listener of conversationListeners) {
        listener({
          schemaVersion: 1,
          eventId: "manual-run-start",
          conversationId: ActiveInterviewConversationId,
          runId: "run-1",
          attemptId: "run-1:attempt:1",
          sequence: 1,
          aggregateRevision: 1,
          producerId: "test",
          occurredAt: "2026-11-07T00:00:00.000Z",
          event: { type: "run-state-changed", state: "running", attempt: 1 },
        });
      }
    });

    await waitFor(() => expect(screen.queryByText("当前回复尚未完成")).not.toBeInTheDocument());
  });

  it("clears the manual-send error when the interview conversation is cleared", async () => {
    const bridge = createConversationBridge();
    const capture = {
      getState: () => ({ phase: "idle" as const }),
      subscribe: () => () => undefined,
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    render(<FloatingBarApp bridge={bridge} interviewCapture={capture} />);
    fireEvent.click(screen.getByRole("button", { name: "对话" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "面试" }));
    fireEvent.click(screen.getByRole("button", { name: "面试演练" }));
    const input = screen.getByRole("textbox", { name: "演练消息" });

    fireEvent.change(input, { target: { value: "先留下的消息" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(screen.getByText("先留下的消息")).toBeInTheDocument());

    bridge.sendInterviewMessage.mockRejectedValueOnce(new Error("当前回复尚未完成"));
    fireEvent.change(input, { target: { value: "失败的第二条" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("当前回复尚未完成"));

    fireEvent.click(screen.getByRole("button", { name: "清空对话历史" }));
    await waitFor(() =>
      expect(bridge.clearConversationMessages).toHaveBeenCalledWith(ActiveInterviewConversationId),
    );
    await waitFor(() => expect(screen.queryByText("当前回复尚未完成")).not.toBeInTheDocument());
  });
});
