import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { FloatingBarApp } from "../src/app/FloatingBarApp";
import {
  clickAnswerScreenshot,
  conversationState,
  createConversationBridge,
  resetFloatingBarTestState,
} from "./support/floatingBarHarness";

describe("floating bar screenshot answer rounds", () => {
  beforeEach(resetFloatingBarTestState);

  it("keeps the pill visible during the inline reply and clears the screenshot on close", async () => {
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
    // 初始对话模式。
    expect(screen.getByRole("button", { name: "打开对话" })).toBeInTheDocument();

    clickAnswerScreenshot();
    await waitFor(() =>
      expect(screen.getByRole("img", { name: /screenshot-.*\.png/ })).toBeInTheDocument(),
    );

    // 就地内联：功能槽接管导航条右侧，截图缩略图直接长在导航条里。
    expect(document.querySelector(".floating-bar .reply-bar")).not.toBeNull();
    // 整段右侧被接管：工作区入口（笔记本/设置）在回复期间让位。
    expect(screen.queryByRole("button", { name: "打开笔记本" })).not.toBeInTheDocument();

    // 收起发送条退出回复槽：清空本轮截图，回到对话面板。
    fireEvent.click(screen.getByRole("button", { name: "收起回复条" }));
    await waitFor(() =>
      expect(screen.queryByRole("img", { name: /screenshot-.*\.png/ })).not.toBeInTheDocument(),
    );
  });

  it("clears the round when closing the reply bar and shows the next round in details", async () => {
    const bridge = createConversationBridge();
    render(<FloatingBarApp bridge={bridge} />);
    clickAnswerScreenshot();
    await waitFor(() =>
      expect(screen.getByRole("img", { name: /screenshot-.*\.png/ })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认发送" }));
    await waitFor(() => expect(bridge.sendConversationMessage).toHaveBeenCalled());
    const firstCommand = bridge.sendConversationMessage.mock.calls[0]?.[0] as
      | { conversationId: string }
      | undefined;
    if (!firstCommand) throw new Error("sendConversationMessage 未被调用");
    const firstConversationId = firstCommand.conversationId;
    await act(async () => {
      conversationState.emit?.({
        runId: "run-1",
        chunk: { type: "text-delta", id: "segment-1", delta: "第一轮答案" },
      });
      conversationState.emit?.({ runId: "run-1", chunk: { type: "finish" } });
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "继续截图" })).toBeInTheDocument(),
    );

    // 关闭回复条：本轮会话立即清空，回到发送条。
    fireEvent.click(screen.getByRole("button", { name: "收起回复条" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "确认发送" })).toBeInTheDocument(),
    );
    expect(bridge.clearConversationMessages).toHaveBeenCalledWith(firstConversationId);

    // 新一轮发送后展开面板：只显示新会话，旧轮次不再残留。
    fireEvent.click(screen.getByRole("button", { name: "继续截图" }));
    await waitFor(() =>
      expect(screen.getByRole("img", { name: /screenshot-.*\.png/ })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认发送" }));
    await waitFor(() => expect(bridge.sendConversationMessage).toHaveBeenCalledTimes(2));
    const secondCommand = bridge.sendConversationMessage.mock.calls[1]?.[0] as
      | { conversationId: string }
      | undefined;
    if (!secondCommand) throw new Error("第二轮发送未被调用");
    expect(secondCommand.conversationId).not.toBe(firstConversationId);
    await act(async () => {
      conversationState.emit?.({
        runId: "run-1",
        chunk: { type: "text-delta", id: "segment-2", delta: "第二轮答案" },
      });
      conversationState.emit?.({ runId: "run-1", chunk: { type: "finish" } });
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "继续截图" })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "展开对话面板" }));

    const details = await screen.findByRole("region", { name: "当前对话" });
    expect(within(details).getByText(/第二轮答案/)).toBeInTheDocument();
    expect(within(details).queryByText(/第一轮答案/)).not.toBeInTheDocument();
    expect(within(details).queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("clears the details panel for each new screenshot answer round", async () => {
    const bridge = createConversationBridge();
    render(<FloatingBarApp bridge={bridge} />);

    clickAnswerScreenshot();
    await waitFor(() =>
      expect(screen.getByRole("img", { name: /screenshot-.*\.png/ })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认发送" }));
    await waitFor(() => expect(bridge.sendConversationMessage).toHaveBeenCalledTimes(1));
    await act(async () => {
      conversationState.emit?.({
        runId: "run-1",
        chunk: { type: "text-delta", id: "segment-1", delta: "答案：D" },
      });
      conversationState.emit?.({ runId: "run-1", chunk: { type: "finish" } });
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "继续截图" })).toBeInTheDocument(),
    );

    // 开始第二轮截图答题：新一轮发送生成新的会话 id，面板不得再显示第一轮记录。
    fireEvent.click(screen.getByRole("button", { name: "收起回复条" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "确认发送" })).toBeInTheDocument(),
    );
    clickAnswerScreenshot();
    await waitFor(() =>
      expect(screen.getByRole("img", { name: /screenshot-.*\.png/ })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认发送" }));
    await waitFor(() => expect(bridge.sendConversationMessage).toHaveBeenCalledTimes(2));
    const secondCommand = bridge.sendConversationMessage.mock.calls[1]?.[0] as
      | { conversationId: string }
      | undefined;
    if (!secondCommand) throw new Error("第二轮发送未被调用");
    const secondConversationId = secondCommand.conversationId;
    expect(secondConversationId).toMatch(/^screenshot-/);

    await act(async () => {
      conversationState.emit?.({
        runId: "run-1",
        chunk: { type: "text-delta", id: "segment-2", delta: "答案：B" },
      });
      conversationState.emit?.({ runId: "run-1", chunk: { type: "finish" } });
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "继续截图" })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "展开对话面板" }));

    const details = screen.getByRole("region", { name: "当前对话" });
    await waitFor(() => expect(within(details).getByText(/答案：B/)).toBeInTheDocument());
    expect(within(details).queryByText(/答案：D/)).not.toBeInTheDocument();
  });

  it("restores the panel that was open before entering screenshot reply workflow", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "打开笔记本" }));
    clickAnswerScreenshot();

    await waitFor(() =>
      expect(screen.getByRole("img", { name: /screenshot-.*\.png/ })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("heading", { name: "笔记本 / 资料" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "收起回复条" }));
    // 工作区面板是懒加载模块；冷启动 transform 可能超过默认 1s 查询窗口。
    expect(
      await screen.findByRole("heading", { name: "笔记本 / 资料" }, { timeout: 5000 }),
    ).toBeInTheDocument();
  });
});
