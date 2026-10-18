import type {
  AuthStatus,
  ConversationChange,
  ConversationMessage,
  ConversationSnapshot,
} from "@answra/shared";
import { ActiveChatConversationId } from "@answra/shared";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { UIMessageChunk } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FloatingBarApp } from "../src/app/FloatingBarApp";
import { ICON } from "../src/tokens";

let emitConversationEvent: ((event: { runId: string; chunk: UIMessageChunk }) => void) | undefined;
const conversationId = "active-exam-conversation";
let emittedConversationId = conversationId;
const conversationListeners = new Set<(change: ConversationChange) => void>();

function createConversationBridge() {
  return {
    close: vi.fn(),
    fitContent: vi.fn(),
    getConversationConfig: vi
      .fn()
      .mockResolvedValue({ baseUrl: "http://localhost/v1", model: "test", configured: true }),
    getConversationSnapshot: vi.fn().mockImplementation(async (id: string) => emptySnapshot(id)),
    createConversation: vi.fn().mockImplementation(async (id: string) => emptySnapshot(id)),
    sendConversationMessage: vi
      .fn()
      .mockImplementation(async (command: { conversationId: string }) => {
        emittedConversationId = command.conversationId;
        return { runId: "run-1" };
      }),
    cancelConversationRun: vi.fn(),
    onConversationChange: vi.fn((listener: (change: ConversationChange) => void) => {
      let revision = 0;
      const messages: ConversationMessage[] = [];
      conversationListeners.add(listener);
      const publish = (change: ConversationChange) => {
        conversationListeners.forEach((subscriber) => {
          subscriber(change);
        });
      };
      emitConversationEvent = ({ runId, chunk }) => {
        revision += 1;
        if (chunk.type === "text-delta") {
          const assistant = messages.find((message) => message.id === runId);
          if (assistant) assistant.text += chunk.delta;
          else
            messages.push({
              id: runId,
              role: "assistant",
              text: chunk.delta,
              images: [],
              status: "streaming",
            });
        }
        if (chunk.type === "finish" || chunk.type === "abort") {
          const assistant = messages.find((message) => message.id === runId);
          if (assistant) assistant.status = "complete";
        }
        const event = { conversationId: emittedConversationId, revision, runId, chunk };
        publish({
          type: "event",
          event,
        });
        if (chunk.type === "finish" || chunk.type === "abort") {
          revision += 1;
          let assistant = messages.find((message) => message.id === runId);
          if (!assistant) {
            assistant = {
              id: runId,
              role: "assistant",
              text: "",
              images: [],
              status: "complete",
            };
            messages.push(assistant);
          }
          publish({
            type: "run-finished",
            conversationId: emittedConversationId,
            revision,
            runId,
            message: {
              ...assistant,
              status: chunk.type === "abort" ? "interrupted" : "complete",
            },
          });
        }
      };
      return () => {
        conversationListeners.delete(listener);
        if (conversationListeners.size === 0) emitConversationEvent = undefined;
      };
    }),
    startRegionCapture: vi.fn().mockResolvedValue({
      dataUrl: "data:image/png;base64,QUJD",
      height: 200,
      ok: true,
      width: 300,
    }),
  };
}

function emptySnapshot(id = conversationId): ConversationSnapshot {
  return { conversationId: id, revision: 0, messages: [] };
}

function clickAnswerScreenshot() {
  if (!screen.queryByRole("button", { name: "截图提问" })) {
    fireEvent.click(screen.getByRole("button", { name: /^(对话|答题|面试|会议)$/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "答题" }));
  }
  fireEvent.click(screen.getByRole("button", { name: "截图提问" }));
}

describe("three-segment floating navigation", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    delete document.documentElement.dataset.theme;
    emitConversationEvent = undefined;
    emittedConversationId = conversationId;
    conversationListeners.clear();
  });

  it("changes the middle feature group when the work mode changes", () => {
    render(<FloatingBarApp />);

    // 启动默认收起：只显示悬浮导航条，对话面板需用户主动打开。
    expect(screen.queryByRole("heading", { name: "AI 对话" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开对话" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "对话" }));
    expect(screen.getByRole("menuitemradio", { name: "对话" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "答题" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "面试" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "会议" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "答题" }));
    expect(screen.getByRole("button", { name: "截图提问" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开对话" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "答题" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "会议" }));
    expect(screen.getByRole("button", { name: "会议助手（即将推出）" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "打开设置" })).toBeInTheDocument();
  });

  it("keeps a single notebook entry and one icon size across the nav bar", () => {
    render(<FloatingBarApp />);

    expect(screen.getAllByRole("button", { name: "打开笔记本" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "打开参考资料" })).not.toBeInTheDocument();

    const bar = document.querySelector(".floating-bar") as HTMLElement;
    const glyphs = [...bar.querySelectorAll("button svg")].filter(
      (glyph) =>
        !glyph.classList.contains("mode-picker-chevron") &&
        !glyph.classList.contains("destination-chevron"),
    );
    expect(glyphs).toHaveLength(5);
    for (const glyph of glyphs) {
      expect(glyph.getAttribute("width")).toBe(String(ICON));
      expect(glyph.getAttribute("height")).toBe(String(ICON));
    }
  });

  it("uses a conversation icon for the chat entry and a voice icon for the interview mode", () => {
    render(<FloatingBarApp />);

    const chatEntry = screen.getByRole("button", { name: "打开对话" });
    expect(chatEntry.querySelector("svg")?.classList.contains("lucide-messages-square")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "对话" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "面试" }));
    const modeTrigger = screen.getByRole("button", { name: "面试" });
    expect(modeTrigger.querySelector("svg")?.classList.contains("lucide-audio-lines")).toBe(true);
  });

  it("sends general chat on its independent conversation and keeps it when the panel closes", async () => {
    const bridge = createConversationBridge();
    render(<FloatingBarApp bridge={bridge} />);

    fireEvent.click(screen.getByRole("button", { name: "打开对话" }));
    const input = screen.getByRole("textbox", { name: "补充问题" });
    fireEvent.change(input, { target: { value: "我叫小明" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
    await waitFor(() =>
      expect(bridge.sendConversationMessage).toHaveBeenCalledWith({
        operation: "chat.send",
        profileId: "general-chat",
        conversationId: ActiveChatConversationId,
        request: { text: "我叫小明", images: [] },
      }),
    );

    act(() =>
      emitConversationEvent?.({
        runId: "run-1",
        chunk: { type: "start", messageId: "run-1" },
      }),
    );
    act(() =>
      emitConversationEvent?.({
        runId: "run-1",
        chunk: { type: "text-start", id: "segment-1" },
      }),
    );
    act(() =>
      emitConversationEvent?.({
        runId: "run-1",
        chunk: { type: "text-delta", id: "segment-1", delta: "你好，小明。" },
      }),
    );
    act(() => emitConversationEvent?.({ runId: "run-1", chunk: { type: "finish" } }));
    await waitFor(() => expect(screen.getByText("你好，小明。")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "收起面板" }));
    expect(screen.queryByRole("heading", { name: "AI 对话" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开对话" }));
    expect(screen.getByText("我叫小明")).toBeInTheDocument();
    expect(screen.getByText("你好，小明。")).toBeInTheDocument();
  });

  it("renders every mode action as a plain icon button without a stuck tint", () => {
    render(<FloatingBarApp />);

    const classes = [...document.querySelectorAll(".feature-action")].map(
      (action) => action.className,
    );
    expect(classes).toHaveLength(1);
    expect(new Set(classes).size).toBe(1);
    expect(classes.every((name) => name.includes("surface-control--default"))).toBe(true);
    expect(classes.some((name) => name.includes("primary"))).toBe(false);
  });

  it("overlays the mode menu on an open panel instead of pushing it down", () => {
    render(<FloatingBarApp />);
    fireEvent.click(screen.getByRole("button", { name: "打开笔记本" }));
    fireEvent.click(screen.getByRole("button", { name: "对话" }));

    // 面板已打开：外壳不得为菜单预留高度，否则窗口变高、面板被下推
    const stack = document.querySelector(".floating-bar-stack");
    expect(stack).not.toHaveClass("is-menu-open");
  });

  it("includes the expanded mode menu in the measured window layout", () => {
    render(<FloatingBarApp />);
    // 启动即收起：菜单直接进入布局流，为窗口预留真实高度。
    fireEvent.click(screen.getByRole("button", { name: "对话" }));

    const menu = screen.getByRole("menu", { name: "工作模式" });
    expect(menu.parentElement).toHaveClass("is-menu-in-flow");
    expect(screen.getByRole("menuitemradio", { name: "会议" })).toBeInTheDocument();
  });

  it("shows the mode menu as a dismissible layer without replacing the open panel", () => {
    render(<FloatingBarApp />);
    fireEvent.click(screen.getByRole("button", { name: "打开笔记本" }));
    fireEvent.click(screen.getByRole("button", { name: "对话" }));

    expect(screen.getByRole("heading", { name: "笔记本 / 资料" })).toBeInTheDocument();
    expect(screen.getByRole("menu", { name: "工作模式" })).toBeInTheDocument();
    expect(screen.getByRole("menu", { name: "工作模式" }).parentElement).not.toHaveClass(
      "is-menu-in-flow",
    );
    expect(screen.getByRole("menuitemradio", { name: "会议" })).toBeInTheDocument();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu", { name: "工作模式" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "笔记本 / 资料" })).toBeInTheDocument();
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
      emittedConversationId = sentId as string;
    });
    act(() =>
      emitConversationEvent?.({
        runId: "run-1",
        chunk: { type: "reasoning-start", id: "reasoning-1" },
      }),
    );
    act(() =>
      emitConversationEvent?.({
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
      emitConversationEvent?.({
        runId: "run-1",
        chunk: { type: "tool-input-start", toolCallId: "tool-1", toolName: "search" },
      }),
    );
    act(() =>
      emitConversationEvent?.({
        runId: "run-1",
        chunk: { type: "tool-output-available", toolCallId: "tool-1", output: "已完成检索" },
      }),
    );
    act(() =>
      emitConversationEvent?.({
        runId: "run-1",
        chunk: { type: "text-start", id: "segment-1" },
      }),
    );
    act(() =>
      emitConversationEvent?.({
        runId: "run-1",
        chunk: { type: "text-delta", id: "segment-1", delta: "截图内容已识别" },
      }),
    );
    act(() => emitConversationEvent?.({ runId: "run-1", chunk: { type: "finish" } }));
    // 完成态：回复条保留答案，停在原地等用户收起，不回退到悬浮导航栏。
    await waitFor(() => expect(screen.getByText("截图内容已识别")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "截图提问" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取消回复并返回发送" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "补充问题" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续截图" })).toBeInTheDocument();

    // 收起回复条 -> 回到发送条（清空本轮截图与答案），而不是直接回悬浮导航条。
    fireEvent.click(screen.getByRole("button", { name: "收起回复条" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "确认发送" })).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "截图提问" })).toBeInTheDocument();
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
      emitConversationEvent?.({
        runId: "run-1",
        chunk: { type: "error", errorText: "模型服务返回 401：API Key 无效" },
      }),
    );
    act(() =>
      emitConversationEvent?.({
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
    expect(screen.getByRole("button", { name: "截图提问" })).toBeInTheDocument();
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

    // 主窗口内联形态：截图直接渲染在工具栏回复槽，不再推送到独立回复窗口。
    await waitFor(() =>
      expect(screen.getByRole("img", { name: /screenshot-.*\.png/ })).toBeInTheDocument(),
    );
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

    // 就地内联：主导航条保留，答题模式"截图提问"入口仍可见。
    expect(screen.getByRole("button", { name: "截图提问" })).toBeInTheDocument();

    // 收起发送条退出回复槽：清空本轮截图，回到对话面板。
    fireEvent.click(screen.getByRole("button", { name: "收起回复条" }));
    await waitFor(() =>
      expect(screen.queryByRole("img", { name: /screenshot-.*\.png/ })).not.toBeInTheDocument(),
    );
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
    expect(await screen.findByRole("heading", { name: "笔记本 / 资料" })).toBeInTheDocument();
  });

  it("opens the workspace panel with directory pick entry and opens settings from the third segment", () => {
    render(<FloatingBarApp />);
    fireEvent.click(screen.getByRole("button", { name: "打开笔记本" }));
    expect(screen.getByRole("button", { name: /选择目录/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
    expect(screen.getByRole("heading", { name: "设置" })).toBeInTheDocument();
  });

  it("toggles ambient background following in settings and persists the choice", () => {
    render(<FloatingBarApp />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));

    const toggle = screen.getByRole("checkbox", { name: /跟随背景色/ });
    expect(toggle).not.toBeChecked();
    expect(toggle).not.toBeDisabled();

    fireEvent.click(toggle);
    expect(toggle).toBeChecked();
    expect(localStorage.getItem("answra-ambient-follow")).toBe("on");

    fireEvent.click(toggle);
    expect(localStorage.getItem("answra-ambient-follow")).toBe("off");
  });

  it("does not offer the removed chameleon veil levels in settings", () => {
    render(<FloatingBarApp />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));

    // 「隐蔽强度」四档已移除：文字不再按对比度求解，避免灰雾字
    expect(screen.queryByRole("button", { name: "隐蔽" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "贴合" })).not.toBeInTheDocument();
    // 前景透明度仍在：它是唯一的前景淡化自由度
    expect(screen.getByRole("slider", { name: "前景透明度" })).toBeInTheDocument();
  });

  it("masks the API key with a closed eye and uses the shared primary save button", async () => {
    const bridge = {
      ...createConversationBridge(),
      configureConversation: vi.fn().mockResolvedValue(undefined),
    };
    render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));

    const keyInput = screen.getByPlaceholderText("必填");
    expect(keyInput).toHaveAttribute("type", "password");
    fireEvent.change(keyInput, { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "显示 API Key" }));
    expect(keyInput).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "保存" })).toHaveClass("surface-control--primary");
    fireEvent.click(screen.getByRole("button", { name: "隐藏 API Key" }));
    expect(keyInput).toHaveAttribute("type", "password");
  });

  it("shows a saved confirmation and keeps the masked key after a successful save", async () => {
    const bridge = {
      ...createConversationBridge(),
      configureConversation: vi.fn().mockResolvedValue(undefined),
    };
    render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));

    const baseUrlInput = screen.getByPlaceholderText("http://127.0.0.1:1234/v1");
    const modelInput = screen.getByPlaceholderText("模型 ID");
    fireEvent.change(baseUrlInput, { target: { value: "http://127.0.0.1:1234/v1" } });
    fireEvent.change(modelInput, { target: { value: "test-model" } });

    const keyInput = screen.getByPlaceholderText("必填");
    fireEvent.change(keyInput, { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(bridge.configureConversation).toHaveBeenCalledTimes(1));
    expect(bridge.configureConversation).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "test-model",
      apiKey: "secret",
    });
    // Key 默认掩码回显，保存成功后保留掩码展示，"已保存"状态给出反馈
    expect(keyInput).toHaveValue("secret");
    expect(keyInput).toHaveAttribute("type", "password");
    expect(screen.getByRole("status")).toHaveTextContent("已保存");
  });

  it("echoes the saved API key masked on open and toggles visibility with the eye icon", async () => {
    const bridge = {
      ...createConversationBridge(),
      getConversationApiKey: vi.fn().mockResolvedValue({ apiKey: "saved-key" }),
    };
    render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));

    const keyInput = screen.getByPlaceholderText("必填");
    // 打开面板即拉取已保存 Key，默认掩码展示
    await waitFor(() => expect(bridge.getConversationApiKey).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(keyInput).toHaveValue("saved-key"));
    expect(keyInput).toHaveAttribute("type", "password");

    fireEvent.click(screen.getByRole("button", { name: "显示 API Key" }));
    expect(keyInput).toHaveAttribute("type", "text");
    expect(keyInput).toHaveValue("saved-key");

    // 再次切换只改显隐，不重复拉取
    fireEvent.click(screen.getByRole("button", { name: "隐藏 API Key" }));
    fireEvent.click(screen.getByRole("button", { name: "显示 API Key" }));
    expect(keyInput).toHaveValue("saved-key");
    expect(bridge.getConversationApiKey).toHaveBeenCalledTimes(1);
  });

  it("keeps ambient and stealth settings independent", async () => {
    const bridge = {
      close: vi.fn(),
      fitContent: vi.fn(),
      getStealthSupport: vi.fn().mockResolvedValue(true),
      setAmbientFollow: vi.fn(),
      setStealth: vi.fn(),
    };
    render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));

    const ambientToggle = screen.getByRole("checkbox", { name: "跟随背景色" });
    const stealthToggle = screen.getByRole("checkbox", { name: "会议隐身" });
    await waitFor(() => expect(stealthToggle).not.toBeDisabled());
    bridge.setAmbientFollow.mockClear();
    bridge.setStealth.mockClear();

    fireEvent.click(ambientToggle);
    expect(ambientToggle).toBeChecked();
    expect(stealthToggle).not.toBeChecked();
    expect(localStorage.getItem("answra-ambient-follow")).toBe("on");
    expect(localStorage.getItem("answra-stealth")).toBeNull();
    expect(bridge.setStealth).not.toHaveBeenCalledWith(true);
    await waitFor(() => expect(bridge.setAmbientFollow).toHaveBeenCalledWith(true));

    fireEvent.click(stealthToggle);
    expect(stealthToggle).toBeChecked();
    expect(ambientToggle).toBeChecked();
    expect(localStorage.getItem("answra-stealth")).toBe("on");
    expect(localStorage.getItem("answra-ambient-follow")).toBe("on");
    expect(bridge.setAmbientFollow).toHaveBeenCalledWith(true);
    await waitFor(() => expect(bridge.setStealth).toHaveBeenCalledWith(true));
  });

  it("adjusts global opacity from settings and persists the choice", () => {
    render(<FloatingBarApp />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));

    const slider = screen.getByRole("slider", { name: "前景透明度" });
    // 缺省不透明（1）：0.8 会把面板玻璃 alpha 压到发灰，可读性靠 blur 承担
    expect(slider).toHaveValue("1");

    fireEvent.change(slider, { target: { value: "0.6" } });
    expect(slider).toHaveValue("0.6");
    // fade 写在 :root（感知令牌在 :root 声明并求值），驱动全部令牌同步缩放
    expect(document.documentElement.style.getPropertyValue("--fade")).toBe("0.6");
    expect(localStorage.getItem("answra-opacity")).toBe("0.6");
  });

  it("toggles meeting stealth in settings, persists the choice, and notifies the bridge", async () => {
    const bridge = {
      close: vi.fn(),
      fitContent: vi.fn(),
      getStealthSupport: vi.fn().mockResolvedValue(true),
      setStealth: vi.fn(),
    };
    render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));

    const toggle = screen.getByRole("checkbox", { name: /会议隐身/ });
    await waitFor(() => expect(toggle).not.toBeDisabled());
    expect(toggle).not.toBeChecked();
    expect(document.querySelector(".overlay-root")).not.toHaveAttribute("data-stealth");

    fireEvent.click(toggle);
    expect(toggle).toBeChecked();
    expect(document.querySelector(".overlay-root")).toHaveAttribute("data-stealth", "true");
    expect(localStorage.getItem("answra-stealth")).toBe("on");
    await waitFor(() => expect(bridge.setStealth).toHaveBeenCalledWith(true));

    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(document.querySelector(".overlay-root")).not.toHaveAttribute("data-stealth");
    expect(localStorage.getItem("answra-stealth")).toBe("off");
    await waitFor(() => expect(bridge.setStealth).toHaveBeenCalledWith(false));
  });

  it("disables meeting stealth when the system does not support content protection", async () => {
    const bridge = {
      close: vi.fn(),
      fitContent: vi.fn(),
      getStealthSupport: vi.fn().mockResolvedValue(false),
      setStealth: vi.fn(),
    };
    render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));

    const toggle = screen.getByRole("checkbox", { name: /会议隐身/ });
    await waitFor(() => expect(toggle).toBeDisabled());
    // 不支持时不向主进程发送隐身指令
    expect(bridge.setStealth).not.toHaveBeenCalled();
  });

  it("treats a failed stealth capability query as unsupported", async () => {
    const bridge = {
      close: vi.fn(),
      fitContent: vi.fn(),
      getStealthSupport: vi.fn().mockRejectedValue(new Error("IPC unavailable")),
      setStealth: vi.fn(),
    };
    render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));

    await waitFor(() => expect(screen.getByRole("checkbox", { name: /会议隐身/ })).toBeDisabled());
    expect(bridge.setStealth).not.toHaveBeenCalledWith(true);
    expect(bridge.setStealth).not.toHaveBeenCalled();
  });

  it("allows disabling a persisted stealth state when support detection fails", async () => {
    localStorage.setItem("answra-stealth", "on");
    const bridge = {
      close: vi.fn(),
      fitContent: vi.fn(),
      getStealthSupport: vi.fn().mockRejectedValue(new Error("IPC unavailable")),
      setStealth: vi.fn(),
    };
    render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));

    const toggle = screen.getByRole("checkbox", { name: "会议隐身" });
    await waitFor(() => expect(toggle).not.toBeDisabled());
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(localStorage.getItem("answra-stealth")).toBe("off");
    await waitFor(() => expect(bridge.setStealth).toHaveBeenCalledWith(false));
  });

  it("reports shell content size through the bridge and closes on demand", () => {
    const bridge = { fitContent: vi.fn(), close: vi.fn() };
    render(<FloatingBarApp bridge={bridge} />);

    fireEvent.click(screen.getByRole("button", { name: "打开笔记本" }));
    expect(screen.getByRole("heading", { name: "笔记本 / 资料" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "收起面板" }));
    expect(screen.queryByRole("heading", { name: "笔记本 / 资料" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭应用" }));
    expect(bridge.close).toHaveBeenCalled();
  });

  it("hides the account block when the bridge exposes no auth API", () => {
    render(<FloatingBarApp bridge={{ fitContent: vi.fn(), close: vi.fn() }} />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));

    expect(screen.queryByRole("heading", { name: "账户" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "登录" })).not.toBeInTheDocument();
  });

  it("starts sign-in from settings and tells the user to finish in the browser", async () => {
    const loginAccount = vi.fn().mockResolvedValue({ opened: true });
    const bridge = {
      ...createConversationBridge(),
      getAuthStatus: vi
        .fn()
        .mockResolvedValue({ signedIn: false, plan: null, capabilities: [], cloudBaseUrl: null }),
      onAuthStatus: vi.fn(() => () => undefined),
      loginAccount,
    };
    render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));

    await waitFor(() => expect(screen.getByText("未登录")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(loginAccount).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByText("已在浏览器中打开授权页，完成后会自动同步")).toBeInTheDocument(),
    );
  });

  it("shows a login failure instead of the browser hint", async () => {
    const bridge = {
      close: vi.fn(),
      fitContent: vi.fn(),
      getAuthStatus: vi
        .fn()
        .mockResolvedValue({ signedIn: false, plan: null, capabilities: [], cloudBaseUrl: null }),
      onAuthStatus: vi.fn(() => () => undefined),
      loginAccount: vi.fn().mockResolvedValue({ opened: false, error: "无法打开授权页" }),
    };
    render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));

    fireEvent.click(await screen.findByRole("button", { name: "登录" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("无法打开授权页");
  });

  it("renders the plan and capability count pushed by the main process", async () => {
    let listener: ((status: AuthStatus) => void) | undefined;
    const bridge = {
      close: vi.fn(),
      fitContent: vi.fn(),
      getAuthStatus: vi.fn().mockResolvedValue({
        signedIn: true,
        plan: "pro",
        capabilities: ["text.chat", "voice.interview"],
        cloudBaseUrl: "https://api.answra.com",
      }),
      onAuthStatus: vi.fn((next: (status: AuthStatus) => void) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      }),
      logoutAccount: vi.fn(),
    };
    render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));

    expect(await screen.findByText("会员")).toBeInTheDocument();
    expect(screen.getByText("已解锁 2 项云能力")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "退出登录" })).toBeInTheDocument();

    // 主进程推送登出（例如凭据失效）后，界面回到未登录。
    act(() => {
      listener?.({ signedIn: false, plan: null, capabilities: [], cloudBaseUrl: null });
    });
    expect(await screen.findByText("未登录")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "登录" })).toBeInTheDocument();
  });

  it("signs out from settings and adopts the returned status", async () => {
    const logoutAccount = vi.fn().mockResolvedValue({
      signedIn: false,
      plan: null,
      capabilities: [],
      cloudBaseUrl: null,
    });
    const bridge = {
      close: vi.fn(),
      fitContent: vi.fn(),
      getAuthStatus: vi.fn().mockResolvedValue({
        signedIn: true,
        plan: "pro",
        capabilities: ["text.chat"],
        cloudBaseUrl: "https://api.answra.com",
      }),
      onAuthStatus: vi.fn(() => () => undefined),
      logoutAccount,
    };
    render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));

    fireEvent.click(await screen.findByRole("button", { name: "退出登录" }));
    expect(logoutAccount).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("未登录")).toBeInTheDocument();
  });

  it("stops listening for auth pushes when the panel closes", async () => {
    const unsubscribe = vi.fn();
    const bridge = {
      ...createConversationBridge(),
      getAuthStatus: vi
        .fn()
        .mockResolvedValue({ signedIn: false, plan: null, capabilities: [], cloudBaseUrl: null }),
      onAuthStatus: vi.fn(() => unsubscribe),
    };
    render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
    const collapse = screen.getByRole("button", { name: "收起面板" });
    fireEvent.click(collapse);

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
