import type {
  ConversationChange,
  ConversationMessage,
  ConversationSnapshot,
  DesktopBridge,
  ReplyBarState,
} from "@answra/shared";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { UIMessageChunk } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplyBarWindowApp } from "../src/app/ReplyBarWindowApp";

const conversationId = "active-exam-conversation";
const runId = "run-live";
let stateListener: ((state: ReplyBarState) => void) | undefined;
let changeListener: ((change: ConversationChange) => void) | undefined;
let previousClipboard: PropertyDescriptor | undefined;
let clipboardOverridden = false;

const snapshot: ConversationSnapshot = {
  conversationId,
  revision: 1,
  activeRunId: runId,
  messages: [
    {
      id: "user-1",
      role: "user",
      text: "请回答",
      images: [],
      status: "complete",
    },
    {
      id: runId,
      role: "assistant",
      text: "初始 **文本**",
      images: [],
      status: "streaming",
    },
  ],
};

function createBridge() {
  return {
    close: vi.fn(),
    fitContent: vi.fn(),
    fitReplyBar: vi.fn(),
    getConversationSnapshot: vi.fn().mockResolvedValue(snapshot),
    readConversationEvents: vi.fn().mockResolvedValue([]),
    onConversationChange: vi.fn((listener: (change: ConversationChange) => void) => {
      changeListener = listener;
      return () => {
        changeListener = undefined;
      };
    }),
    onReplyBarPlacement: vi.fn(() => () => undefined),
    onReplyBarState: vi.fn((listener: (state: ReplyBarState) => void) => {
      stateListener = listener;
      return () => {
        stateListener = undefined;
      };
    }),
    requestReplyBarState: vi.fn(),
    sendReplyBarAction: vi.fn(),
  } satisfies Partial<DesktopBridge>;
}

function replyState(stealth = false): ReplyBarState {
  return {
    phase: "streaming",
    attachments: [],
    draft: "",
    replyText: "用于 ticker 的摘要",
    replyActivities: [],
    replyPending: true,
    stealth,
    theme: { variables: {} },
  };
}

describe("ReplyBarWindowApp live conversation popover", () => {
  afterEach(() => {
    if (!clipboardOverridden) return;
    if (previousClipboard) Object.defineProperty(navigator, "clipboard", previousClipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
    previousClipboard = undefined;
    clipboardOverridden = false;
  });

  beforeEach(() => {
    stateListener = undefined;
    changeListener = undefined;
  });

  it("shows snapshot markdown and applies arriving text deltas without ticker replay", async () => {
    const bridge = createBridge();
    render(<ReplyBarWindowApp bridge={bridge as DesktopBridge} />);
    act(() => stateListener?.(replyState()));
    await waitFor(() =>
      expect(bridge.getConversationSnapshot).toHaveBeenCalledWith(conversationId),
    );

    fireEvent.mouseEnter(document.querySelector(".reply-activity-viewport") as HTMLElement);
    expect(await screen.findByRole("region", { name: "当前对话" })).toBeInTheDocument();
    expect(screen.getByText("初始")).toBeInTheDocument();
    expect(screen.getByText("文本").tagName).toBe("STRONG");

    act(() => {
      changeListener?.({
        type: "event",
        event: {
          conversationId,
          runId,
          revision: 2,
          chunk: { type: "text-delta", id: "text-1", delta: " 实时" } as UIMessageChunk,
        },
      });
    });
    await waitFor(() => expect(screen.getByText(/实时/)).toBeInTheDocument());
    expect(bridge.readConversationEvents).toHaveBeenCalledWith(conversationId, 0);
  });

  it("recovers a missing revision from the event journal", async () => {
    const bridge = createBridge();
    bridge.readConversationEvents.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        type: "event",
        event: {
          conversationId,
          runId,
          revision: 2,
          chunk: {
            type: "reasoning-delta",
            id: "reasoning-1",
            delta: "先检查条件",
          } as UIMessageChunk,
        },
      },
    ]);
    render(<ReplyBarWindowApp bridge={bridge as DesktopBridge} />);
    act(() => stateListener?.(replyState()));
    await waitFor(() =>
      expect(bridge.readConversationEvents).toHaveBeenCalledWith(conversationId, 0),
    );
    act(() => {
      changeListener?.({
        type: "run-finished",
        conversationId,
        runId,
        revision: 3,
        message: { ...(snapshot.messages[1] as ConversationMessage), status: "complete" },
      });
    });
    fireEvent.mouseEnter(document.querySelector(".reply-activity-viewport") as HTMLElement);
    expect(await screen.findByText("先检查条件")).toBeInTheDocument();
    expect(bridge.readConversationEvents).toHaveBeenCalledWith(conversationId, 1);
  });

  it("renders reasoning in a neutral collapsible block instead of italic answer text", async () => {
    const bridge = createBridge();
    bridge.getConversationSnapshot.mockResolvedValue({
      ...snapshot,
      revision: 3,
      messages: [snapshot.messages[0], { ...snapshot.messages[1], text: "最终答案" }],
    });
    bridge.readConversationEvents.mockResolvedValue([
      {
        type: "event",
        event: {
          conversationId,
          runId,
          revision: 2,
          chunk: {
            type: "reasoning-delta",
            id: "reasoning-1",
            delta: "先检查题目条件",
          } as UIMessageChunk,
        },
      },
      {
        type: "event",
        event: {
          conversationId,
          runId,
          revision: 3,
          chunk: { type: "text-delta", id: "text-1", delta: "最终答案" } as UIMessageChunk,
        },
      },
    ]);
    render(<ReplyBarWindowApp bridge={bridge as DesktopBridge} />);
    act(() => stateListener?.(replyState()));
    fireEvent.mouseEnter(document.querySelector(".reply-activity-viewport") as HTMLElement);

    expect(await screen.findByText("先检查题目条件")).toBeInTheDocument();
    expect(await screen.findByText("最终答案")).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "切换思考过程" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("先检查题目条件")).toBeInTheDocument();
    expect(screen.getByText("最终答案")).toBeInTheDocument();
  });

  it("uses one thinking state and collapses reasoning when the answer block starts", async () => {
    const bridge = createBridge();
    bridge.getConversationSnapshot.mockResolvedValue({
      ...snapshot,
      revision: 2,
      // 本轮刚开口：只有思维链，回答正文尚未开始
      messages: [snapshot.messages[0], { ...snapshot.messages[1], text: "" }],
    });
    bridge.readConversationEvents.mockResolvedValue([
      {
        type: "event",
        event: {
          conversationId,
          runId,
          revision: 2,
          chunk: {
            type: "reasoning-delta",
            id: "reasoning-1",
            delta: "正在检查条件",
          } as UIMessageChunk,
        },
      },
    ]);
    render(<ReplyBarWindowApp bridge={bridge as DesktopBridge} />);
    act(() => stateListener?.(replyState()));
    fireEvent.mouseEnter(document.querySelector(".reply-activity-viewport") as HTMLElement);

    expect(await screen.findByText("思考中…")).toBeInTheDocument();
    expect(screen.getAllByText("思考中…")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "切换思考过程" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    act(() => {
      changeListener?.({
        type: "event",
        event: {
          conversationId,
          runId,
          revision: 3,
          chunk: { type: "text-delta", id: "text-1", delta: "答案" } as UIMessageChunk,
        },
      });
    });

    const thoughtToggle = await screen.findByRole("button", { name: "切换思考过程" });
    await waitFor(() => expect(thoughtToggle).toHaveAttribute("aria-expanded", "false"));
    expect(screen.getByText(/答案/)).toBeInTheDocument();
    expect(screen.queryByText("思考中…")).not.toBeInTheDocument();
  });

  it("shows message actions only after a completed assistant reply", async () => {
    const bridge = createBridge();
    const writeText = vi.fn().mockResolvedValue(undefined);
    previousClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    clipboardOverridden = true;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<ReplyBarWindowApp bridge={bridge as DesktopBridge} />);
    act(() => stateListener?.(replyState()));
    await waitFor(() => expect(bridge.getConversationSnapshot).toHaveBeenCalled());
    fireEvent.mouseEnter(document.querySelector(".reply-activity-viewport") as HTMLElement);

    expect(screen.queryByRole("button", { name: "复制" })).not.toBeInTheDocument();
    act(() => {
      changeListener?.({
        type: "run-finished",
        conversationId,
        runId,
        revision: 2,
        message: { ...(snapshot.messages[1] as ConversationMessage), status: "complete" },
      });
    });

    const copy = await screen.findByRole("button", { name: "复制" });
    expect(copy).toBeInTheDocument();
    fireEvent.click(copy);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("初始 **文本**"));
  });

  it("follows new output while at the bottom and pauses when the reader scrolls up", async () => {
    const bridge = createBridge();
    render(<ReplyBarWindowApp bridge={bridge as DesktopBridge} />);
    act(() => stateListener?.(replyState()));
    await waitFor(() => expect(bridge.getConversationSnapshot).toHaveBeenCalled());
    fireEvent.mouseEnter(document.querySelector(".reply-activity-viewport") as HTMLElement);
    await screen.findByRole("region", { name: "当前对话" });
    const scroll = document.querySelector(".reply-conversation-scroll") as HTMLElement;
    let scrollTop = 0;
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 1000 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
    });

    act(() => {
      changeListener?.({
        type: "event",
        event: {
          conversationId,
          runId,
          revision: 2,
          chunk: { type: "text-delta", id: "text-1", delta: "更多内容" } as UIMessageChunk,
        },
      });
    });
    await waitFor(() => expect(scrollTop).toBe(1000));

    scrollTop = 100;
    fireEvent.scroll(scroll);
    act(() => {
      changeListener?.({
        type: "event",
        event: {
          conversationId,
          runId,
          revision: 3,
          chunk: { type: "text-delta", id: "text-1", delta: "新答案" } as UIMessageChunk,
        },
      });
    });
    await waitFor(() => expect(screen.getByText(/新答案/)).toBeInTheDocument());
    expect(scrollTop).toBe(100);
    expect(screen.getByRole("button", { name: "定位到最新回复" })).toBeInTheDocument();
  });

  it("shows user screenshots as compact previews without filenames", async () => {
    const bridge = createBridge();
    bridge.getConversationSnapshot.mockResolvedValue({
      ...snapshot,
      messages: [
        {
          ...(snapshot.messages[0] as ConversationMessage),
          images: [{ name: "exam-question.png", dataUrl: "data:image/png;base64,AA==" }],
        },
      ],
    });
    render(<ReplyBarWindowApp bridge={bridge as DesktopBridge} />);
    act(() => stateListener?.(replyState()));
    fireEvent.mouseEnter(document.querySelector(".reply-activity-viewport") as HTMLElement);

    const image = await screen.findByRole("img", { name: "题目截图" });
    expect(image).toHaveAttribute("src", "data:image/png;base64,AA==");
    expect(screen.queryByText("exam-question.png")).not.toBeInTheDocument();
    expect(image.closest("figure")).toHaveClass("reply-conversation-image");
  });

  it("keeps a disabled composer below the conversation and identifies stealth mode", async () => {
    const bridge = createBridge();
    render(<ReplyBarWindowApp bridge={bridge as DesktopBridge} />);
    act(() => stateListener?.(replyState(true)));
    fireEvent.mouseEnter(document.querySelector(".reply-activity-viewport") as HTMLElement);

    expect(await screen.findByRole("textbox", { name: "消息输入" })).toBeDisabled();
    expect(screen.getByPlaceholderText("隐身模式下不可输入")).toBeDisabled();
    expect(screen.getByRole("button", { name: "添加附件" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "发送消息" })).toBeDisabled();
    expect(document.querySelector(".conversation-composer")?.nextElementSibling).toBeNull();
  });

  it("opens only when hovering the reply text area, not the action buttons", async () => {
    const bridge = createBridge();
    render(<ReplyBarWindowApp bridge={bridge as DesktopBridge} />);
    act(() => stateListener?.(replyState()));

    fireEvent.mouseEnter(document.querySelector(".reply-actions--stream") as HTMLElement);
    expect(screen.queryByRole("region", { name: "当前对话" })).not.toBeInTheDocument();

    fireEvent.mouseEnter(document.querySelector(".reply-activity-viewport") as HTMLElement);
    expect(await screen.findByRole("region", { name: "当前对话" })).toBeInTheDocument();
  });
});
