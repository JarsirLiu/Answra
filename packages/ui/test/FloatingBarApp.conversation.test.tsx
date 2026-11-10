import type { ConversationSnapshot } from "@answra/shared";
import { ActiveChatConversationId, AGENT_SERVICE_DISCONNECTED_CODE } from "@answra/shared";
import type { AgentEventEnvelope } from "@answra/shared/schema";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FloatingBarApp } from "../src/app/FloatingBarApp";
import {
  conversationListeners,
  conversationState,
  createConversationBridge,
  resetFloatingBarTestState,
} from "./support/floatingBarHarness";

describe("floating bar conversation", () => {
  beforeEach(resetFloatingBarTestState);

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
      conversationState.emit?.({
        runId: "run-1",
        chunk: { type: "start", messageId: "run-1" },
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
        chunk: { type: "text-delta", id: "segment-1", delta: "你好，小明。" },
      }),
    );
    act(() => conversationState.emit?.({ runId: "run-1", chunk: { type: "finish" } }));
    await waitFor(() => expect(screen.getByText("你好，小明。")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "收起面板" }));
    expect(screen.queryByRole("heading", { name: "AI 对话" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开对话" }));
    expect(await screen.findByText("我叫小明")).toBeInTheDocument();
    expect(await screen.findByText("你好，小明。")).toBeInTheDocument();
  });

  it("clears the failed-round error when the chat conversation is cleared", async () => {
    const bridge = createConversationBridge();
    render(<FloatingBarApp bridge={bridge} />);

    fireEvent.click(screen.getByRole("button", { name: "打开对话" }));
    const input = screen.getByRole("textbox", { name: "补充问题" });
    fireEvent.change(input, { target: { value: "这轮会失败" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
    await waitFor(() => expect(bridge.sendConversationMessage).toHaveBeenCalled());

    act(() =>
      conversationState.emit?.({
        runId: "run-1",
        chunk: { type: "error", errorText: "模型流未提供终态" },
      }),
    );
    act(() => conversationState.emit?.({ runId: "run-1", chunk: { type: "finish" } }));

    const stream = screen.getByRole("log", { name: "对话消息" });
    expect(await within(stream).findByRole("alert")).toHaveTextContent("模型流未提供终态");

    const clear = screen.getByRole("button", { name: "清空对话历史" });
    await waitFor(() => expect(clear).toBeEnabled());
    fireEvent.click(clear);

    await waitFor(() =>
      expect(bridge.clearConversationMessages).toHaveBeenCalledWith(ActiveChatConversationId),
    );
    await waitFor(() =>
      expect(within(stream).queryByText("模型流未提供终态")).not.toBeInTheDocument(),
    );
  });

  it("keeps the draft visible while chat send is pending, then renders the returned snapshot", async () => {
    const bridge = createConversationBridge();
    const earlyEvents: AgentEventEnvelope[] = [];
    bridge.readConversationEvents.mockImplementation(async (_id, afterRevision) =>
      earlyEvents.filter((event) => event.aggregateRevision > afterRevision),
    );
    let acceptSend: (value: { runId: string; snapshot: ConversationSnapshot }) => void = () => {
      throw new Error("send response was not initialized");
    };
    bridge.sendConversationMessage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acceptSend = resolve;
        }),
    );
    render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "打开对话" }));
    const input = screen.getByRole("textbox", { name: "补充问题" });
    fireEvent.change(input, { target: { value: "这条消息不能消失" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    expect(screen.getByRole("log", { name: "对话消息" })).toHaveClass("conversation--chat");
    expect(input).toHaveValue("这条消息不能消失");
    expect(input).toBeDisabled();
    await waitFor(() => expect(bridge.sendConversationMessage).toHaveBeenCalled());

    const publishEarlyEvent = (aggregateRevision: number, event: AgentEventEnvelope["event"]) => {
      const envelope: AgentEventEnvelope = {
        schemaVersion: 1,
        eventId: `early-${aggregateRevision}`,
        conversationId: ActiveChatConversationId,
        runId: "run-delayed",
        attemptId: "run-delayed:attempt:1",
        sequence: aggregateRevision,
        aggregateRevision,
        producerId: "test",
        occurredAt: "2026-11-07T00:00:00.000Z",
        event,
      };
      earlyEvents.push(envelope);
      act(() => {
        conversationListeners.forEach((listener) => {
          listener(envelope);
        });
      });
    };
    publishEarlyEvent(1, { type: "run-state-changed", state: "running", attempt: 1 });
    publishEarlyEvent(2, { type: "text-delta", partId: "text-1", delta: "模型已经开始回复" });
    publishEarlyEvent(3, { type: "run-state-changed", state: "completed", attempt: 1 });

    await act(async () => {
      acceptSend({
        runId: "run-delayed",
        snapshot: {
          conversationId: ActiveChatConversationId,
          eventRevision: 0,
          activeRunId: "run-delayed",
          messages: [
            {
              id: "user-delayed",
              role: "user",
              text: "这条消息不能消失",
              images: [],
              status: "complete",
            },
            {
              id: "run-delayed",
              role: "assistant",
              text: "",
              images: [],
              status: "streaming",
            },
          ],
        },
      });
    });

    expect(await screen.findByText("这条消息不能消失")).toBeInTheDocument();
    expect(await screen.findByText("模型已经开始回复")).toBeInTheDocument();
    expect(input).toHaveValue("");
  });

  it("shows the run icon after Agent acceptance and replaces it with the thinking event", async () => {
    const bridge = createConversationBridge();
    let acceptSend: (value: { runId: string; snapshot: ConversationSnapshot }) => void = () => {
      throw new Error("send response was not initialized");
    };
    bridge.sendConversationMessage.mockImplementationOnce(
      () => new Promise((resolve) => (acceptSend = resolve)),
    );
    render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "打开对话" }));
    fireEvent.change(screen.getByRole("textbox", { name: "补充问题" }), {
      target: { value: "你好" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(bridge.sendConversationMessage).toHaveBeenCalled());

    expect(screen.queryByRole("status", { name: "回复运行中" })).not.toBeInTheDocument();
    await act(async () => {
      acceptSend({
        runId: "run-accepted",
        snapshot: {
          conversationId: ActiveChatConversationId,
          eventRevision: 0,
          activeRunId: "run-accepted",
          messages: [
            {
              id: "user-accepted",
              role: "user",
              text: "你好",
              images: [],
              status: "complete",
            },
            {
              id: "run-accepted",
              role: "assistant",
              text: "",
              images: [],
              status: "streaming",
            },
          ],
        },
      });
    });

    expect(await screen.findByRole("status", { name: "回复运行中" })).toBeInTheDocument();
    const reasoningStart: AgentEventEnvelope = {
      schemaVersion: 1,
      eventId: "accepted-reasoning-start",
      conversationId: ActiveChatConversationId,
      runId: "run-accepted",
      attemptId: "run-accepted:attempt:1",
      sequence: 1,
      aggregateRevision: 1,
      producerId: "test",
      occurredAt: "2026-11-07T00:00:00.000Z",
      event: { type: "reasoning-start", partId: "reasoning-1" },
    };
    act(() => {
      conversationListeners.forEach((listener) => {
        listener(reasoningStart);
      });
    });
    expect(await screen.findByText("思考中…")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "回复运行中" })).not.toBeInTheDocument();

    const completed: AgentEventEnvelope = {
      ...reasoningStart,
      eventId: "accepted-completed",
      sequence: 2,
      aggregateRevision: 2,
      event: { type: "run-state-changed", state: "completed", attempt: 1 },
    };
    act(() => {
      conversationListeners.forEach((listener) => {
        listener(completed);
      });
    });
  });

  it("prompts sign-in inside the conversation when the main process rejects a chat send", async () => {
    const bridge = {
      ...createConversationBridge(),
      getAuthStatus: vi
        .fn()
        .mockResolvedValue({ signedIn: false, plan: null, capabilities: [], cloudBaseUrl: null }),
      onAuthStatus: vi.fn(() => () => undefined),
      loginAccount: vi.fn().mockResolvedValue({ opened: true }),
      sendConversationMessage: vi
        .fn()
        .mockRejectedValue(new Error("auth-required: 请先登录后再使用（设置 → 账户）")),
    };
    render(<FloatingBarApp bridge={bridge} />);

    fireEvent.click(screen.getByRole("button", { name: "打开对话" }));
    const input = screen.getByRole("textbox", { name: "补充问题" });
    fireEvent.change(input, { target: { value: "你好" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: false });

    // 只看失败码：提示统一，且不把 IPC 包装后的原始文案展示给用户。
    const stream = screen.getByRole("log", { name: "对话消息" });
    expect(await within(stream).findByRole("alert")).toHaveTextContent(
      "请先登录后再使用（设置 → 账户）",
    );
    // 失败留在对话正文里：不另弹浮层横条，也不自动把用户切到设置面板。
    expect(screen.queryByRole("button", { name: "登录" })).not.toBeInTheDocument();
    // 草稿保留，登录后可原样重发。
    expect(screen.getByRole("textbox", { name: "补充问题" })).toHaveValue("你好");
    // 登录入口就在提示里，点了才去拉起授权页（失败本身不自动开浏览器）。
    fireEvent.click(within(stream).getByRole("button", { name: "去登录" }));
    await waitFor(() => expect(bridge.loginAccount).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: "登录" })).not.toBeInTheDocument();
  });

  it("shows a service error when a chat send fails because the worker disconnected", async () => {
    const bridge = {
      ...createConversationBridge(),
      sendConversationMessage: vi
        .fn()
        .mockRejectedValue(new Error(`${AGENT_SERVICE_DISCONNECTED_CODE}: worker is not running`)),
    };
    render(<FloatingBarApp bridge={bridge} />);

    fireEvent.click(screen.getByRole("button", { name: "打开对话" }));
    const input = screen.getByRole("textbox", { name: "补充问题" });
    fireEvent.change(input, { target: { value: "你好" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: false });

    const stream = screen.getByRole("log", { name: "对话消息" });
    expect(await within(stream).findByRole("alert")).toHaveTextContent(
      "本地 AI 服务暂不可用，请稍后重试",
    );
    expect(screen.queryByRole("button", { name: "去登录" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "补充问题" })).toHaveValue("你好");
  });
});
