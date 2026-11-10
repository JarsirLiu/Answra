import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FloatingBarApp } from "../src/app/FloatingBarApp";
import {
  clickAnswerScreenshot,
  conversationId,
  conversationState,
  createConversationBridge,
  resetFloatingBarTestState,
} from "./support/floatingBarHarness";

describe("floating bar screenshot answer", () => {
  beforeEach(resetFloatingBarTestState);

  it("renders the in-place reply bar keys as plain icon buttons without a brand tint", async () => {
    const bridge = createConversationBridge();
    render(<FloatingBarApp bridge={bridge} />);
    clickAnswerScreenshot();
    await waitFor(() =>
      expect(screen.getByRole("img", { name: /screenshot-.*\.png/ })).toBeInTheDocument(),
    );

    // 发送条：确认发送与缩略图删除键都走默认变体（中性图标色 + hover 底色），不带薄荷实底。
    for (const button of [
      screen.getByRole("button", { name: "确认发送" }),
      screen.getByRole("button", { name: "移除截图" }),
    ]) {
      expect(button).toHaveClass("surface-control--default");
      expect(button.className).not.toContain("primary");
    }

    // 回复条：流式态的取消/停止键同样不带薄荷实底。
    fireEvent.click(screen.getByRole("button", { name: "确认发送" }));
    await waitFor(() => expect(bridge.sendConversationMessage).toHaveBeenCalled());
    const stop = await screen.findByRole("button", { name: "取消回复并返回发送" });
    expect(stop).toHaveClass("surface-control--default");
    expect(stop.className).not.toContain("primary");
  });

  it("attaches a screenshot, accepts a follow-up prompt, and streams the reply in the bar", async () => {
    const bridge = createConversationBridge();
    render(<FloatingBarApp bridge={bridge} />);
    clickAnswerScreenshot();
    await waitFor(() =>
      expect(screen.getByRole("img", { name: /screenshot-.*\.png/ })).toBeInTheDocument(),
    );

    expect(screen.queryByRole("textbox", { name: "补充问题" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认发送" }));

    await waitFor(() => {
      const [command] = bridge.sendConversationMessage.mock.calls[0] ?? [];
      const sentId = command?.conversationId;
      expect(sentId).toMatch(/^screenshot-/);
      expect(sentId).not.toBe(conversationId);
      expect(command).toMatchObject({
        operation: "answer.run",
        request: {
          text: "",
          images: [expect.objectContaining({ dataUrl: "data:image/png;base64,QUJD" })],
        },
      });
      expect(bridge.createConversation).toHaveBeenCalledWith(sentId);
      conversationState.emittedConversationId = sentId as string;
    });
    act(() =>
      conversationState.emit?.({
        runId: "run-1",
        chunk: { type: "reasoning-start", id: "reasoning-1" },
      }),
    );
    act(() =>
      conversationState.emit?.({
        runId: "run-1",
        chunk: { type: "reasoning-delta", id: "reasoning-1", delta: "先分析题目条件" },
      }),
    );
    await waitFor(() => expect(screen.getByLabelText("当前事件：思考")).toBeInTheDocument());
    expect(screen.getByLabelText("当前事件：思考").querySelector("svg")).not.toHaveClass(
      "reply-activity-spinner",
    );
    expect(screen.getByText("先分析题目条件").closest(".reply-activity-item")).toHaveClass(
      "reply-activity-item--thinking",
    );
    act(() =>
      conversationState.emit?.({
        runId: "run-1",
        chunk: { type: "tool-input-start", toolCallId: "tool-1", toolName: "search" },
      }),
    );
    act(() =>
      conversationState.emit?.({
        runId: "run-1",
        chunk: { type: "tool-output-available", toolCallId: "tool-1", output: "已完成检索" },
      }),
    );
    act(() =>
      conversationState.emit?.({
        runId: "run-1",
        chunk: { type: "text-start", id: "segment-1" },
      }),
    );
    act(() =>
      conversationState.emit?.({
        runId: "run-1",
        chunk: { type: "text-delta", id: "segment-1", delta: "截图内容已识别" },
      }),
    );
    act(() => conversationState.emit?.({ runId: "run-1", chunk: { type: "finish" } }));
    // 完成态：回复条就地停在导航条功能槽内，停在原地等用户收起。
    await waitFor(() => expect(screen.getByText("截图内容已识别")).toBeInTheDocument());
    expect(document.querySelector(".floating-bar .reply-bar")).not.toBeNull();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "取消回复并返回发送" })).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("textbox", { name: "补充问题" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续截图" })).toBeInTheDocument();

    // 收起回复条 -> 回到发送条（清空本轮截图与答案），而不是直接回悬浮导航条。
    fireEvent.click(screen.getByRole("button", { name: "收起回复条" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "确认发送" })).toBeInTheDocument(),
    );
    expect(screen.queryByText("截图内容已识别")).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /screenshot-.*\.png/ })).not.toBeInTheDocument();

    // 再收起发送条，才回悬浮导航条。
    fireEvent.click(screen.getByRole("button", { name: "收起回复条" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "截图提问" })).toBeInTheDocument(),
    );
  });

  it("shows model errors and keeps the screenshot available for retry", async () => {
    const bridge = createConversationBridge();
    render(<FloatingBarApp bridge={bridge} />);
    clickAnswerScreenshot();
    await waitFor(() =>
      expect(screen.getByRole("img", { name: /screenshot-.*\.png/ })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认发送" }));
    await waitFor(() => expect(bridge.sendConversationMessage).toHaveBeenCalled());

    act(() =>
      conversationState.emit?.({
        runId: "run-1",
        chunk: { type: "error", errorText: "模型服务返回 401：API Key 无效" },
      }),
    );
    act(() =>
      conversationState.emit?.({
        runId: "run-1",
        chunk: { type: "finish", finishReason: "error" },
      }),
    );

    await waitFor(() =>
      expect(screen.getByText("模型服务返回 401：API Key 无效")).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByRole("img", { name: /screenshot-.*\.png/ })).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "确认发送" })).toBeInTheDocument();
  });

  it("shows a rejected screenshot answer on screen instead of only logging it", async () => {
    const bridge = createConversationBridge();
    bridge.sendConversationMessage.mockRejectedValue(
      new Error("auth-required: 请先登录后再使用（设置 → 账户）"),
    );
    render(<FloatingBarApp bridge={bridge} />);
    clickAnswerScreenshot();
    await waitFor(() =>
      expect(screen.getByRole("img", { name: /screenshot-.*\.png/ })).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "确认发送" }));

    // 截图答题的失败同样留在回复条里，不再另弹浮层横条或自动切换面板。
    expect(await screen.findByRole("alert")).toHaveTextContent("请先登录后再使用（设置 → 账户）");
    expect(screen.queryByRole("button", { name: "登录" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "去登录" })).toBeInTheDocument();
  });

  it("keeps a failed model round in the current conversation panel", async () => {
    const bridge = createConversationBridge();
    render(<FloatingBarApp bridge={bridge} />);
    clickAnswerScreenshot();
    await waitFor(() =>
      expect(screen.getByRole("img", { name: /screenshot-.*\.png/ })).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "确认发送" }));
    await waitFor(() => expect(bridge.sendConversationMessage).toHaveBeenCalled());
    act(() =>
      conversationState.emit?.({
        runId: "run-1",
        chunk: {
          type: "error",
          errorText:
            "No model service is configured for this plan yet. Please contact the administrator.",
        },
      }),
    );
    act(() => conversationState.emit?.({ runId: "run-1", chunk: { type: "finish" } }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No model service is configured for this plan yet.",
    );
    fireEvent.click(screen.getByRole("button", { name: "展开对话面板" }));

    const details = await screen.findByRole("region", { name: "当前对话" });
    expect(
      within(details).getByText(/No model service is configured for this plan yet\./),
    ).toBeInTheDocument();
    expect(within(details).getByRole("img", { name: "题目截图" })).toBeInTheDocument();
    expect(within(details).queryByText("发送后将在这里显示本轮对话")).not.toBeInTheDocument();
    // 详情只读：不再提供继续打字的输入框。
    expect(within(details).queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("captures a region screenshot through the bridge and attaches it to the chat", async () => {
    const bridge = createConversationBridge();
    render(<FloatingBarApp bridge={bridge} />);
    clickAnswerScreenshot();

    await waitFor(() =>
      expect(screen.getByRole("img", { name: /screenshot-.*\.png/ })).toBeInTheDocument(),
    );
    expect(bridge.startRegionCapture).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("textbox", { name: "补充问题" })).not.toBeInTheDocument();
  });

  it("cancels an inline reply and returns to the same send bar", async () => {
    const bridge = createConversationBridge();
    render(<FloatingBarApp bridge={bridge} />);
    clickAnswerScreenshot();
    await waitFor(() =>
      expect(screen.getByRole("img", { name: /screenshot-.*\.png/ })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认发送" }));

    await waitFor(() => expect(bridge.sendConversationMessage).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "取消回复并返回发送" }));
    await waitFor(() => expect(bridge.cancelConversationRun).toHaveBeenCalledWith("run-1"));

    expect(screen.getByRole("button", { name: "继续截图" })).toBeInTheDocument();
    expect(screen.queryByText(/演示回复/)).not.toBeInTheDocument();
    // 取消只回到发送态：功能槽仍是回复条，没有退回悬浮导航条。
    expect(screen.getByRole("button", { name: "确认发送" })).toBeInTheDocument();
  });

  it("renders the screenshot inline instead of syncing to a detached reply window", async () => {
    const bridge = {
      close: vi.fn(),
      fitContent: vi.fn(),
      startRegionCapture: vi.fn().mockResolvedValue({
        dataUrl: "data:image/png;base64,QUJD",
        height: 200,
        ok: true,
        width: 300,
      }),
    };
    render(<FloatingBarApp bridge={bridge} />);
    clickAnswerScreenshot();

    // 主窗口内联形态：截图缩略图直接长在导航条功能槽里，不再推送独立回复窗口、也不另起一条。
    await waitFor(() =>
      expect(screen.getByRole("img", { name: /screenshot-.*\.png/ })).toBeInTheDocument(),
    );
    expect(document.querySelector(".floating-bar .reply-bar")).not.toBeNull();
    expect((bridge as { setReplyBarState?: unknown }).setReplyBarState).toBeUndefined();
  });

  it("appends another screenshot when 继续截图 is clicked inside the reply bar", async () => {
    const bridge = {
      close: vi.fn(),
      fitContent: vi.fn(),
      startRegionCapture: vi.fn().mockResolvedValue({
        dataUrl: "data:image/png;base64,QUJD",
        height: 200,
        ok: true,
        width: 300,
      }),
    };
    render(<FloatingBarApp bridge={bridge} />);
    clickAnswerScreenshot();
    await waitFor(() =>
      expect(screen.getByRole("img", { name: /screenshot-.*\.png/ })).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "继续截图" }));
    await waitFor(() => expect(bridge.startRegionCapture).toHaveBeenCalledTimes(2));
    expect(screen.getAllByRole("img", { name: /screenshot-.*\.png/ })).toHaveLength(2);
  });

  it("keeps the chat empty when the user cancels the region capture", async () => {
    const bridge = {
      close: vi.fn(),
      fitContent: vi.fn(),
      startRegionCapture: vi.fn().mockResolvedValue({ ok: false, reason: "cancelled" }),
    };
    render(<FloatingBarApp bridge={bridge} />);
    clickAnswerScreenshot();

    await waitFor(() => expect(bridge.startRegionCapture).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("img", { name: /screenshot-.*\.png/ })).not.toBeInTheDocument();
  });

  it("surfaces a capture failure on screen instead of silently returning to the pill", async () => {
    const bridge = {
      close: vi.fn(),
      fitContent: vi.fn(),
      startRegionCapture: vi.fn().mockResolvedValue({
        message: "没有可用的屏幕画面",
        ok: false,
        reason: "unavailable",
      }),
    };
    render(<FloatingBarApp bridge={bridge} />);
    clickAnswerScreenshot();

    // 非取消的失败必须屏幕可见（role=alert），且回复条不出现
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText("没有可用的屏幕画面")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /screenshot-.*\.png/ })).not.toBeInTheDocument();
  });

  it("does not show an error when the capture is cancelled by the user", async () => {
    const bridge = {
      close: vi.fn(),
      fitContent: vi.fn(),
      startRegionCapture: vi.fn().mockResolvedValue({ ok: false, reason: "cancelled" }),
    };
    render(<FloatingBarApp bridge={bridge} />);
    clickAnswerScreenshot();

    await waitFor(() => expect(bridge.startRegionCapture).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /screenshot-.*\\.png/ })).not.toBeInTheDocument();
  });
});
