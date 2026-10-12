import type { ConversationEvent } from "@answra/shared";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FloatingBarApp } from "../src/app/FloatingBarApp";

let emitConversationEvent: ((event: ConversationEvent) => void) | undefined;

function createConversationBridge() {
  return {
    close: vi.fn(),
    fitContent: vi.fn(),
    getConversationConfig: vi
      .fn()
      .mockResolvedValue({ baseUrl: "http://localhost/v1", model: "test", configured: true }),
    sendConversationMessage: vi.fn().mockResolvedValue({ runId: "run-1" }),
    cancelConversationRun: vi.fn(),
    onConversationEvent: vi.fn((listener: (event: ConversationEvent) => void) => {
      emitConversationEvent = listener;
      return () => {
        emitConversationEvent = undefined;
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

describe("three-segment floating navigation", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    delete document.documentElement.dataset.theme;
    emitConversationEvent = undefined;
  });

  it("changes the middle feature group when the work mode changes", () => {
    render(<FloatingBarApp />);

    expect(screen.getByRole("button", { name: "截图提问" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "笔试" }));
    expect(screen.getByRole("menuitemradio", { name: "笔试" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "面试" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "会议" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "面试" }));
    expect(screen.getByRole("button", { name: "AI 建议（即将推出）" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "截图提问" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "面试" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "会议" }));
    expect(screen.getByRole("button", { name: "会议记录" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开设置" })).toBeInTheDocument();
  });

  it("shows the mode menu as a dismissible layer without replacing the open panel", () => {
    render(<FloatingBarApp />);
    fireEvent.click(screen.getByRole("button", { name: "打开笔记本" }));
    fireEvent.click(screen.getByRole("button", { name: "笔试" }));

    expect(screen.getByRole("heading", { name: "笔记本" })).toBeInTheDocument();
    expect(screen.getByRole("menu", { name: "工作模式" })).toBeInTheDocument();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu", { name: "工作模式" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "笔记本" })).toBeInTheDocument();
  });

  it("attaches a screenshot, accepts a follow-up prompt, and streams the reply in the bar", async () => {
    const bridge = createConversationBridge();
    render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "截图提问" }));
    await waitFor(() =>
      expect(screen.getByRole("img", { name: /screenshot-.*\.png/ })).toBeInTheDocument(),
    );

    expect(screen.getByRole("img", { name: /screenshot-.*\.png/ })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "补充问题" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认发送" }));

    await waitFor(() =>
      expect(bridge.sendConversationMessage).toHaveBeenCalledWith({
        text: "",
        images: [expect.objectContaining({ dataUrl: "data:image/png;base64,QUJD" })],
      }),
    );
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
    await waitFor(() => expect(screen.getByText("截图内容已识别")).toBeInTheDocument());
    expect(screen.getByText("思考")).toBeInTheDocument();
    expect(screen.getByText("先分析题目条件")).toBeInTheDocument();
    expect(screen.getByText("工具：search")).toBeInTheDocument();
    expect(screen.getByText("已完成检索")).toBeInTheDocument();
    const activityViewport = screen.getByRole("log", { name: "模型回复活动" });
    expect(activityViewport).toHaveAttribute("data-orientation", "horizontal");
    expect(activityViewport.querySelector(".reply-activity-track")).toBeInTheDocument();
    expect(screen.getByLabelText("当前事件：回答")).toBeInTheDocument();
    const stopButton = screen.getByRole("button", { name: "取消回复并返回发送" });
    const closeButton = screen.getByRole("button", { name: "收起回复条" });
    expect(stopButton.closest(".reply-actions--stream")).toBe(
      closeButton.closest(".reply-actions--stream"),
    );
    expect(
      stopButton.compareDocumentPosition(closeButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "补充问题" })).not.toBeInTheDocument();
  });

  it("shows model errors and keeps the screenshot available for retry", async () => {
    const bridge = createConversationBridge();
    render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "截图提问" }));
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
    expect(screen.getByRole("img", { name: /screenshot-.*\.png/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认发送" })).toBeInTheDocument();
  });

  it("captures a region screenshot through the bridge and attaches it to the chat", async () => {
    const bridge = createConversationBridge();
    render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "截图提问" }));

    await waitFor(() =>
      expect(screen.getByRole("img", { name: /screenshot-.*\.png/ })).toBeInTheDocument(),
    );
    expect(bridge.startRegionCapture).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("textbox", { name: "补充问题" })).not.toBeInTheDocument();
  });

  it("cancels an inline reply and returns to the same send bar", async () => {
    const bridge = createConversationBridge();
    render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "截图提问" }));
    await waitFor(() =>
      expect(screen.getByRole("img", { name: /screenshot-.*\.png/ })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "确认发送" }));

    await waitFor(() => expect(bridge.sendConversationMessage).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "取消回复并返回发送" }));
    expect(bridge.cancelConversationRun).toHaveBeenCalledWith("run-1");

    expect(screen.getByRole("button", { name: "继续截图" })).toBeInTheDocument();
    expect(screen.queryByText(/演示回复/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "截图提问" })).not.toBeInTheDocument();
  });

  it("syncs screenshot workflow to the detached reply window instead of rendering it in the toolbar", async () => {
    const originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
    const originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperties(HTMLElement.prototype, {
      offsetHeight: { configurable: true, get: () => 48 },
      offsetWidth: { configurable: true, get: () => 400 },
    });
    const bridge = {
      close: vi.fn(),
      fitContent: vi.fn(),
      fitReplyBar: vi.fn(),
      setReplyBarState: vi.fn(),
      startRegionCapture: vi.fn().mockResolvedValue({
        dataUrl: "data:image/png;base64,QUJD",
        height: 200,
        ok: true,
        width: 300,
      }),
    };
    const view = render(<FloatingBarApp bridge={bridge} />);
    try {
      expect(bridge.fitContent).toHaveBeenCalledWith({ height: 48, width: 400 });
      fireEvent.click(screen.getByRole("button", { name: "截图提问" }));

      await waitFor(() => expect(bridge.setReplyBarState).toHaveBeenCalled());
      const state = bridge.setReplyBarState.mock.calls.at(-1)?.[0];
      expect(state).toMatchObject({
        phase: "composing",
        draft: "",
      });
      expect(state.attachments).toHaveLength(1);
      expect(screen.queryByRole("img", { name: /screenshot-.*\.png/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "截图提问" })).not.toBeInTheDocument();
      expect(bridge.fitContent).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
      if (originalWidth) {
        Object.defineProperty(HTMLElement.prototype, "offsetWidth", originalWidth);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "offsetWidth");
      }
      if (originalHeight) {
        Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalHeight);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
      }
    }
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
    fireEvent.click(screen.getByRole("button", { name: "截图提问" }));
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
    fireEvent.click(screen.getByRole("button", { name: "截图提问" }));

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
    fireEvent.click(screen.getByRole("button", { name: "截图提问" }));

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
    fireEvent.click(screen.getByRole("button", { name: "截图提问" }));

    await waitFor(() => expect(bridge.startRegionCapture).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /screenshot-.*\\.png/ })).not.toBeInTheDocument();
  });

  it("hides the pill in focused send mode and restores it when the reply bar closes", async () => {
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
    expect(screen.getByRole("button", { name: "截图提问" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "截图提问" }));
    await waitFor(() =>
      expect(screen.getByRole("img", { name: /screenshot-.*\.png/ })).toBeInTheDocument(),
    );

    // 专注发送态：胶囊退场，全屏只留回复条
    expect(screen.queryByRole("button", { name: "截图提问" })).not.toBeInTheDocument();

    // 收起任务条后，主导航回归
    fireEvent.click(screen.getByRole("button", { name: "收起回复条" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "截图提问" })).toBeInTheDocument(),
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
    fireEvent.click(screen.getByRole("button", { name: "截图提问" }));

    await waitFor(() =>
      expect(screen.getByRole("img", { name: /screenshot-.*\.png/ })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("heading", { name: "笔记本" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "收起回复条" }));
    expect(await screen.findByRole("heading", { name: "笔记本" })).toBeInTheDocument();
  });

  it("saves notebook text locally and opens settings from the third segment", () => {
    render(<FloatingBarApp />);
    fireEvent.click(screen.getByRole("button", { name: "打开笔记本" }));
    fireEvent.change(screen.getByRole("textbox", { name: "个人笔记" }), {
      target: { value: "先确认输入约束" },
    });
    expect(localStorage.getItem("answra-note")).toBe("先确认输入约束");

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
    expect(screen.getByRole("heading", { name: "笔记本" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "收起面板" }));
    expect(screen.queryByRole("heading", { name: "笔记本" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭应用" }));
    expect(bridge.close).toHaveBeenCalled();
  });
});
