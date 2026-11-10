import type { AuthStatus, ConversationMessage, ConversationSnapshot } from "@answra/shared";
import { ActiveChatConversationId, ActiveInterviewConversationId } from "@answra/shared";
import type { AgentEventEnvelope, AgentStreamEvent } from "@answra/shared/schema";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { UIMessageChunk } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FloatingBarApp } from "../src/app/FloatingBarApp";
import { ICON } from "../src/tokens";

let emitConversationEvent: ((event: { runId: string; chunk: UIMessageChunk }) => void) | undefined;
const conversationId = "active-exam-conversation";
let emittedConversationId = conversationId;
const conversationListeners = new Set<(event: AgentEventEnvelope) => void>();

/** Test-only bridge from the legacy chunk fixtures to the app-owned stream shape. */
function toStream(chunk: UIMessageChunk): AgentStreamEvent | undefined {
  switch (chunk.type) {
    case "start":
      return { type: "start" };
    case "text-start":
      return { type: "text-start", partId: chunk.id };
    case "text-end":
      return { type: "text-end", partId: chunk.id };
    case "text-delta":
      return { type: "text-delta", partId: chunk.id, delta: chunk.delta };
    case "reasoning-start":
      return { type: "reasoning-start", partId: chunk.id };
    case "reasoning-end":
      return { type: "reasoning-end", partId: chunk.id };
    case "reasoning-delta":
      return { type: "reasoning-delta", partId: chunk.id, delta: chunk.delta };
    case "tool-input-start":
      return {
        type: "tool-input-start",
        toolCallId: chunk.toolCallId,
        toolName: chunk.toolName,
        ...(chunk.title === undefined ? {} : { title: chunk.title }),
      };
    case "tool-input-delta":
      return {
        type: "tool-input-delta",
        toolCallId: chunk.toolCallId,
        delta: chunk.inputTextDelta,
      };
    case "tool-input-available":
      return {
        type: "tool-call",
        toolCallId: chunk.toolCallId,
        toolName: chunk.toolName,
        input: chunk.input,
      };
    case "tool-output-available":
      return { type: "tool-result", toolCallId: chunk.toolCallId, output: chunk.output };
    case "tool-input-error":
    case "tool-output-error":
      return {
        type: "tool-error",
        toolCallId: chunk.toolCallId,
        errorText: chunk.errorText,
      };
    case "source-url":
      return {
        type: "source-url",
        sourceId: chunk.sourceId,
        url: chunk.url,
        ...(chunk.title === undefined ? {} : { title: chunk.title }),
      };
    case "source-document":
      return {
        type: "source-document",
        sourceId: chunk.sourceId,
        mediaType: chunk.mediaType,
        title: chunk.title,
      };
    case "error":
      return { type: "error", errorText: chunk.errorText };
    default:
      return undefined;
  }
}

function createConversationBridge() {
  const snapshots = new Map<string, ConversationSnapshot>();
  const snapshotFor = (id: string) => snapshots.get(id) ?? emptySnapshot(id);
  const saveSnapshot = (snapshot: ConversationSnapshot) => {
    snapshots.set(snapshot.conversationId, snapshot);
    return snapshot;
  };
  return {
    close: vi.fn(),
    fitContent: vi.fn(),
    getConversationSnapshot: vi.fn().mockImplementation(async (id: string) => snapshotFor(id)),
    readConversationEvents: vi.fn().mockResolvedValue([]),
    createConversation: vi
      .fn()
      .mockImplementation(async (id: string) => saveSnapshot(snapshotFor(id))),
    clearConversationMessages: vi.fn().mockImplementation(async (id: string) => {
      return saveSnapshot(emptySnapshot(id));
    }),
    sendConversationMessage: vi
      .fn()
      .mockImplementation(
        async (command: {
          conversationId: string;
          operation?: string;
          request?: { text?: string; images?: Array<{ name: string; dataUrl: string }> };
        }) => {
          emittedConversationId = command.conversationId;
          // send returns the transcript snapshot; subsequent model output is carried by envelopes.
          if (command.operation && command.request) {
            const userMessage: ConversationMessage = {
              id: `user-${command.conversationId.slice(-8)}`,
              role: "user",
              text: command.request.text ?? "",
              images: command.request.images ?? [],
              status: "complete",
            };
            const assistantMessage: ConversationMessage = {
              id: "run-1",
              role: "assistant",
              text: "",
              images: [],
              status: "streaming",
            };
            const snapshot = saveSnapshot({
              conversationId: command.conversationId,
              eventRevision: 1,
              messages: [userMessage, assistantMessage],
              activeRunId: "run-1",
            });
            return {
              runId: "run-1",
              snapshot,
            };
          }
          return { runId: "run-1", snapshot: emptySnapshot(command.conversationId) };
        },
      ),
    appendConversationUserMessage: vi.fn(async (id: string, text: string) => {
      const prior = snapshotFor(id);
      return saveSnapshot({
        ...prior,
        eventRevision: prior.eventRevision,
        messages: [
          ...prior.messages,
          {
            id: `user-${prior.eventRevision + 1}`,
            role: "user",
            text,
            images: [],
            status: "complete",
          },
        ],
      });
    }),
    cancelConversationRun: vi.fn(),
    onConversationEvent: vi.fn((listener: (event: AgentEventEnvelope) => void) => {
      let scopeId = "";
      let revision = 0;
      let seq = 0;
      const messages: ConversationMessage[] = [];
      conversationListeners.add(listener);
      const publish = (event: AgentEventEnvelope) => {
        conversationListeners.forEach((subscriber) => {
          subscriber(event);
        });
      };
      emitConversationEvent = ({ runId, chunk }) => {
        if (scopeId !== emittedConversationId) {
          scopeId = emittedConversationId;
          revision = 1;
          seq = 0;
          messages.length = 0;
        }
        const stream = toStream(chunk);
        if (stream) {
          revision += 1;
          seq += 1;
          if (stream.type === "text-delta") {
            const assistant = messages.find((message) => message.id === runId);
            if (assistant) assistant.text += stream.delta;
            else
              messages.push({
                id: runId,
                role: "assistant",
                text: stream.delta,
                images: [],
                status: "streaming",
              });
            const snapshot = snapshotFor(emittedConversationId);
            const assistantText =
              messages.find((message) => message.id === runId)?.text ?? stream.delta;
            saveSnapshot({
              ...snapshot,
              eventRevision: snapshot.eventRevision,
              messages: snapshot.messages.map((message) =>
                message.id === runId ? { ...message, text: assistantText } : message,
              ),
            });
          }
          publish({
            schemaVersion: 1,
            eventId: `event-${revision}`,
            attemptId: `${runId}:attempt:1`,
            producerId: "test",
            occurredAt: "2026-11-07T00:00:00.000Z",
            aggregateRevision: revision,
            sequence: seq,
            conversationId: emittedConversationId,
            runId,
            event: stream,
          });
        }
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
          const snapshot = snapshotFor(emittedConversationId);
          saveSnapshot({
            ...snapshot,
            eventRevision: revision,
            activeRunId: undefined,
            messages: snapshot.messages.map((message) =>
              message.id === runId ? { ...message, status: "complete" } : message,
            ),
          });
          publish({
            schemaVersion: 1,
            eventId: `event-${revision}`,
            attemptId: `${runId}:attempt:1`,
            producerId: "test",
            occurredAt: "2026-11-07T00:00:00.000Z",
            aggregateRevision: revision,
            sequence: seq + 1,
            conversationId: emittedConversationId,
            runId,
            event: {
              type: "run-state-changed",
              state: chunk.type === "abort" ? "aborted" : "completed",
              attempt: 1,
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
  return { conversationId: id, eventRevision: 0, messages: [] };
}

function clickAnswerScreenshot() {
  if (!screen.queryByRole("button", { name: "截图提问" })) {
    fireEvent.click(screen.getByRole("button", { name: /^(对话|答题|面试)$/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "答题" }));
  }
  fireEvent.click(screen.getByRole("button", { name: "截图提问" }));
}

describe("three-segment floating navigation", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.stealth;
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
    expect(screen.queryByRole("menuitemradio", { name: "会议" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "答题" }));
    expect(screen.getByRole("button", { name: "截图提问" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开对话" })).not.toBeInTheDocument();

    expect(screen.queryByRole("button", { name: "会议助手（即将推出）" })).not.toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "面试对话" }));
    expect(screen.getByRole("region", { name: "面试对话" })).toBeInTheDocument();
  });

  it("appends interview text as a user message without starting a model run", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "面试对话" }));
    fireEvent.change(screen.getByRole("textbox", { name: "面试消息" }), {
      target: { value: "只追加用户消息" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    await waitFor(() =>
      expect(bridge.appendConversationUserMessage).toHaveBeenCalledWith(
        ActiveInterviewConversationId,
        "只追加用户消息",
      ),
    );
    expect(bridge.sendConversationMessage).not.toHaveBeenCalled();
    expect(await screen.findByText("只追加用户消息")).toHaveClass("message-content");
  });

  it("keeps the interview draft and shows the failure when the append is rejected", async () => {
    const bridge = createConversationBridge();
    bridge.appendConversationUserMessage.mockRejectedValueOnce(new Error("当前回复尚未完成"));
    const capture = {
      getState: () => ({ phase: "idle" as const }),
      subscribe: () => () => undefined,
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    render(<FloatingBarApp bridge={bridge} interviewCapture={capture} />);
    fireEvent.click(screen.getByRole("button", { name: "对话" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "面试" }));
    fireEvent.click(screen.getByRole("button", { name: "面试对话" }));
    const input = screen.getByRole("textbox", { name: "面试消息" });
    fireEvent.change(input, { target: { value: "不能丢的草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("当前回复尚未完成"));
    expect(input).toHaveValue("不能丢的草稿");
  });

  it("clears a stale manual-send error when a new assistant reply starts", async () => {
    const bridge = createConversationBridge();
    bridge.appendConversationUserMessage.mockRejectedValueOnce(new Error("当前回复尚未完成"));
    const capture = {
      getState: () => ({ phase: "idle" as const }),
      subscribe: () => () => undefined,
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    render(<FloatingBarApp bridge={bridge} interviewCapture={capture} />);
    fireEvent.click(screen.getByRole("button", { name: "对话" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "面试" }));
    fireEvent.click(screen.getByRole("button", { name: "面试对话" }));
    const input = screen.getByRole("textbox", { name: "面试消息" });
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
    fireEvent.click(screen.getByRole("button", { name: "面试对话" }));
    const input = screen.getByRole("textbox", { name: "面试消息" });

    fireEvent.change(input, { target: { value: "先留下的消息" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(screen.getByText("先留下的消息")).toBeInTheDocument());

    bridge.appendConversationUserMessage.mockRejectedValueOnce(new Error("当前回复尚未完成"));
    fireEvent.change(input, { target: { value: "失败的第二条" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("当前回复尚未完成"));

    fireEvent.click(screen.getByRole("button", { name: "清空对话历史" }));
    await waitFor(() =>
      expect(bridge.clearConversationMessages).toHaveBeenCalledWith(ActiveInterviewConversationId),
    );
    await waitFor(() => expect(screen.queryByText("当前回复尚未完成")).not.toBeInTheDocument());
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
      emitConversationEvent?.({
        runId: "run-1",
        chunk: { type: "error", errorText: "模型流未提供终态" },
      }),
    );
    act(() => emitConversationEvent?.({ runId: "run-1", chunk: { type: "finish" } }));

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
    expect(screen.queryByRole("menuitemradio", { name: "会议" })).not.toBeInTheDocument();
  });

  it("shows the mode menu as a dismissible layer without replacing the open panel", async () => {
    render(<FloatingBarApp />);
    fireEvent.click(screen.getByRole("button", { name: "打开笔记本" }));
    fireEvent.click(screen.getByRole("button", { name: "对话" }));

    expect(
      await screen.findByRole("heading", { name: "笔记本 / 资料" }, { timeout: 10_000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("menu", { name: "工作模式" })).toBeInTheDocument();
    expect(screen.getByRole("menu", { name: "工作模式" }).parentElement).not.toHaveClass(
      "is-menu-in-flow",
    );
    expect(screen.queryByRole("menuitemradio", { name: "会议" })).not.toBeInTheDocument();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu", { name: "工作模式" })).not.toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "笔记本 / 资料" }, { timeout: 10_000 }),
    ).toBeInTheDocument();
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
      emitConversationEvent?.({
        runId: "run-1",
        chunk: {
          type: "error",
          errorText:
            "No model service is configured for this plan yet. Please contact the administrator.",
        },
      }),
    );
    act(() => emitConversationEvent?.({ runId: "run-1", chunk: { type: "finish" } }));

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
      emitConversationEvent?.({
        runId: "run-1",
        chunk: { type: "text-delta", id: "segment-1", delta: "第一轮答案" },
      });
      emitConversationEvent?.({ runId: "run-1", chunk: { type: "finish" } });
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
      emitConversationEvent?.({
        runId: "run-1",
        chunk: { type: "text-delta", id: "segment-2", delta: "第二轮答案" },
      });
      emitConversationEvent?.({ runId: "run-1", chunk: { type: "finish" } });
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
      emitConversationEvent?.({
        runId: "run-1",
        chunk: { type: "text-delta", id: "segment-1", delta: "答案：D" },
      });
      emitConversationEvent?.({ runId: "run-1", chunk: { type: "finish" } });
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
      emitConversationEvent?.({
        runId: "run-1",
        chunk: { type: "text-delta", id: "segment-2", delta: "答案：B" },
      });
      emitConversationEvent?.({ runId: "run-1", chunk: { type: "finish" } });
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
    expect(await screen.findByRole("heading", { name: "笔记本 / 资料" })).toBeInTheDocument();
  });

  it("opens the workspace panel with directory pick entry and opens settings from the third segment", () => {
    render(<FloatingBarApp />);
    fireEvent.click(screen.getByRole("button", { name: "打开笔记本" }));
    expect(screen.getByRole("button", { name: /选择目录/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
    // Tab 栏即面板头部：无"设置"标题行
    expect(screen.queryByRole("heading", { name: "设置" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "设置" })).toHaveAttribute("aria-selected", "true");
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

  it("offers local model configuration in development and switches to cloud subscription", async () => {
    const bridge = {
      ...createConversationBridge(),
      getConversationConfig: vi.fn().mockResolvedValue({
        source: "local",
        localAvailable: true,
        baseUrl: "http://127.0.0.1:1234/v1",
        model: "local-model",
        answerModel: "",
        configured: true,
      }),
      getConversationApiKey: vi.fn().mockResolvedValue({ apiKey: "secret-key" }),
      configureConversation: vi.fn().mockImplementation(async (settings) => ({
        source: settings.source,
        localAvailable: true,
        baseUrl: settings.baseUrl,
        model: settings.model,
        answerModel: settings.answerModel ?? "",
        configured: Boolean(settings.baseUrl && settings.model),
      })),
    };
    render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));

    // 「设置」页先常规后模型：高频开关在更易触达的上方
    await screen.findByRole("heading", { name: "模型" });
    expect(screen.getAllByRole("heading").map((heading) => heading.textContent)).toEqual([
      "常规",
      "模型",
    ]);
    expect(screen.getByPlaceholderText("http://127.0.0.1:1234/v1")).toHaveValue(
      "http://127.0.0.1:1234/v1",
    );
    expect(screen.getByPlaceholderText("必填")).toHaveValue("local-model");
    expect(screen.getByRole("button", { name: "保存" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "云端订阅" }));
    expect(screen.queryByPlaceholderText("http://127.0.0.1:1234/v1")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "本地模型" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(bridge.configureConversation).toHaveBeenCalledWith(
        expect.objectContaining({ source: "local", model: "local-model" }),
      ),
    );
  });

  it("hides local model configuration in packaged builds", async () => {
    const bridge = {
      ...createConversationBridge(),
      getConversationConfig: vi.fn().mockResolvedValue({
        source: "cloud",
        localAvailable: false,
        baseUrl: "",
        model: "",
        answerModel: "",
        configured: false,
      }),
    };
    render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));

    // 打包版整块「模型」分组不渲染，不留空壳标题
    await screen.findByRole("heading", { name: "常规" });
    expect(screen.queryByRole("heading", { name: "模型" })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("http://127.0.0.1:1234/v1")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存" })).not.toBeInTheDocument();
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
    expect(document.documentElement).not.toHaveAttribute("data-stealth");

    fireEvent.click(toggle);
    expect(toggle).toBeChecked();
    expect(document.querySelector(".overlay-root")).toHaveAttribute("data-stealth", "true");
    expect(document.documentElement).toHaveAttribute("data-stealth", "true");
    expect(localStorage.getItem("answra-stealth")).toBe("on");
    await waitFor(() => expect(bridge.setStealth).toHaveBeenCalledWith(true));

    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(document.querySelector(".overlay-root")).not.toHaveAttribute("data-stealth");
    expect(document.documentElement).not.toHaveAttribute("data-stealth");
    expect(localStorage.getItem("answra-stealth")).toBe("off");
    await waitFor(() => expect(bridge.setStealth).toHaveBeenCalledWith(false));
  });

  it("enables meeting stealth by default in packaged builds unless the user turned it off", async () => {
    const bridge = {
      close: vi.fn(),
      fitContent: vi.fn(),
      getStealthSupport: vi.fn().mockResolvedValue(true),
      isPackaged: true,
      setStealth: vi.fn(),
    };
    const { unmount } = render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));

    const toggle = screen.getByRole("checkbox", { name: "会议隐身" });
    expect(toggle).toBeChecked();
    expect(document.documentElement).toHaveAttribute("data-stealth", "true");
    expect(localStorage.getItem("answra-stealth")).toBeNull();
    await waitFor(() => expect(bridge.setStealth).toHaveBeenCalledWith(true));

    unmount();
    localStorage.setItem("answra-stealth", "off");
    const secondBridge = { ...bridge, setStealth: vi.fn() };
    render(<FloatingBarApp bridge={secondBridge} />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
    expect(screen.getByRole("checkbox", { name: "会议隐身" })).not.toBeChecked();
    expect(document.documentElement).not.toHaveAttribute("data-stealth");
    await waitFor(() => expect(secondBridge.setStealth).toHaveBeenCalledWith(false));
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

    // 无账户能力时连「账户」入口都不出现，避免留下空壳 Tab。
    expect(screen.queryByRole("tab", { name: "账户" })).not.toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("tab", { name: "账户" }));

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
    fireEvent.click(screen.getByRole("tab", { name: "账户" }));

    fireEvent.click(await screen.findByRole("button", { name: "登录" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("无法打开授权页");
  });

  it("stays signed-in without quota data and returns to signed-out after a logout push", async () => {
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
    fireEvent.click(screen.getByRole("tab", { name: "账户" }));

    expect(await screen.findByText("已登录")).toBeInTheDocument();
    // 能力目录是「已实现的接口面」，不渲染成「已解锁 N 项能力」，避免把目录当额度。
    expect(screen.queryByText(/已解锁/)).not.toBeInTheDocument();
    // 档位徽章只由服务端额度摘要（quota）承载；旧快照无额度数据时不猜档位语义。
    expect(screen.queryByText("会员")).not.toBeInTheDocument();
    expect(screen.queryByText("本月额度")).not.toBeInTheDocument();
    expect(screen.queryByText("套餐")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "退出登录" })).toBeInTheDocument();

    // 主进程推送登出（例如凭据失效）后，界面回到未登录。
    act(() => {
      listener?.({ signedIn: false, plan: null, capabilities: [], cloudBaseUrl: null });
    });
    expect(await screen.findByText("未登录")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "登录" })).toBeInTheDocument();
  });

  it("shows the signed-in account identity and available subscription credits", async () => {
    const bridge = {
      close: vi.fn(),
      fitContent: vi.fn(),
      getAuthStatus: vi.fn().mockResolvedValue({
        signedIn: true,
        plan: "pro",
        account: { email: "admin@answra.local", username: "admin" },
        quota: {
          kind: "subscription",
          planName: "标准版",
          availableCredits: 50,
          usedCredits: 30,
          totalCredits: 80,
          usedPercent: 37.5,
          expiresAt: "2026-12-01T00:00:00Z",
          daysRemaining: 42,
        },
        capabilities: [],
        cloudBaseUrl: "https://api.answra.com",
      }),
      onAuthStatus: vi.fn(() => () => undefined),
      logoutAccount: vi.fn(),
    };
    render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
    fireEvent.click(screen.getByRole("tab", { name: "账户" }));

    expect(await screen.findByText("admin@answra.local")).toBeInTheDocument();
    expect(screen.getByText("标准版")).toBeInTheDocument();
    // 档位由徽章表达，「套餐」行不再重复出现。
    expect(screen.queryByText("套餐")).not.toBeInTheDocument();
    expect(screen.getByText("50 积分")).toBeInTheDocument();
    // 可用积分是额度卡主行：标签在左、数值在右。
    expect(screen.getByText("可用积分")).toBeInTheDocument();
    expect(screen.getByText("剩余 42 天")).toBeInTheDocument();
    expect(screen.getByText("本周期已用")).toBeInTheDocument();
    expect(screen.getByText("30 / 80 积分")).toBeInTheDocument();
    const meter = screen.getByRole("progressbar", { name: "本月额度用量" });
    expect(meter).toHaveAttribute("aria-valuenow", "38");
    // 有额度数据时不出现「未开通套餐」占位。
    expect(screen.queryByText("未开通套餐")).not.toBeInTheDocument();
  });

  it("shows free users' available credits and welfare expiry without exposing balance", async () => {
    const bridge = {
      close: vi.fn(),
      fitContent: vi.fn(),
      getAuthStatus: vi.fn().mockResolvedValue({
        signedIn: true,
        plan: "default",
        account: { email: "free@answra.local", username: "free" },
        quota: {
          kind: "default",
          planName: "免费版",
          availableCredits: 18,
          welfareCredits: 10,
          accountCredits: 8,
          welfareExpiresAt: "2026-11-01T00:00:00Z",
          usedPercent: null,
          expiresAt: null,
          daysRemaining: null,
        },
        capabilities: ["text.chat"],
        cloudBaseUrl: "https://api.answra.com",
      }),
      onAuthStatus: vi.fn(() => () => undefined),
      logoutAccount: vi.fn(),
    };
    render(<FloatingBarApp bridge={bridge} />);
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
    fireEvent.click(screen.getByRole("tab", { name: "账户" }));

    expect(await screen.findByText("免费版")).toBeInTheDocument();
    expect(screen.getByText("18 积分")).toBeInTheDocument();
    expect(screen.getByText("福利积分")).toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText("账户额度")).toBeInTheDocument();
    expect(screen.getByText("8")).toBeInTheDocument();
    expect(screen.getByText("福利到期")).toBeInTheDocument();
    expect(screen.queryByText(/¥|余额/)).not.toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("tab", { name: "账户" }));

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
