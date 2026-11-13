import type { AgentConnectionState, ContextCompactionStatus } from "@answra/shared";
import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import type {
  ConversationRetry,
  ConversationViewMessage,
} from "../src/components/chat/conversationMessage";
import { ChatPanel } from "../src/components/panels/ChatPanel";

interface ChatRenderOptions {
  connection?: AgentConnectionState;
  contextCompaction?: ContextCompactionStatus;
  error?: string;
  retry?: ConversationRetry;
}

function renderChat(messages: ConversationViewMessage[], options: ChatRenderOptions = {}): void {
  render(
    <ChatPanel
      attachments={[]}
      draft=""
      fileInputRef={createRef<HTMLInputElement>()}
      messages={messages}
      onAttachmentChange={vi.fn()}
      onAttachmentRemove={vi.fn()}
      onCancel={vi.fn()}
      onClose={vi.fn()}
      onDraftChange={vi.fn()}
      onSend={vi.fn()}
      stealth={false}
      streaming={false}
      connection={options.connection}
      contextCompaction={options.contextCompaction}
      error={options.error}
      retry={options.retry}
    />,
  );
}

describe("ChatPanel context compaction", () => {
  it("shows automatic compaction progress without a model error", () => {
    renderChat([], {
      contextCompaction: {
        state: "summarizing",
        trigger: "auto",
        startedAt: "2026-11-13T10:00:00.000Z",
        updatedAt: "2026-11-13T10:00:01.000Z",
      },
    });

    expect(screen.getByText("正在压缩上下文…")).toBeInTheDocument();
  });

  it("shows the compaction result and failure independently", () => {
    const { rerender } = render(
      <ChatPanel
        attachments={[]}
        contextCompaction={{
          state: "succeeded",
          trigger: "auto",
          startedAt: "2026-11-13T10:00:00.000Z",
          updatedAt: "2026-11-13T10:00:01.000Z",
          finishedAt: "2026-11-13T10:00:01.000Z",
          summarizedMessages: 8,
        }}
        draft=""
        fileInputRef={createRef<HTMLInputElement>()}
        messages={[]}
        onAttachmentChange={vi.fn()}
        onAttachmentRemove={vi.fn()}
        onCancel={vi.fn()}
        onClose={vi.fn()}
        onDraftChange={vi.fn()}
        onSend={vi.fn()}
        stealth={false}
        streaming={false}
      />,
    );

    expect(screen.getByText("上下文压缩完成（8 条消息）")).toBeInTheDocument();

    rerender(
      <ChatPanel
        attachments={[]}
        contextCompaction={{
          state: "failed",
          trigger: "auto",
          startedAt: "2026-11-13T10:00:00.000Z",
          updatedAt: "2026-11-13T10:00:01.000Z",
          finishedAt: "2026-11-13T10:00:01.000Z",
          errorText: "摘要模型不可用",
        }}
        draft=""
        fileInputRef={createRef<HTMLInputElement>()}
        messages={[]}
        onAttachmentChange={vi.fn()}
        onAttachmentRemove={vi.fn()}
        onCancel={vi.fn()}
        onClose={vi.fn()}
        onDraftChange={vi.fn()}
        onSend={vi.fn()}
        stealth={false}
        streaming={false}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("上下文压缩失败：摘要模型不可用");
  });
});

describe("ChatPanel tool calls", () => {
  it("renders a compact tool row inline from message parts", () => {
    renderChat([
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
            output: {
              type: "text",
              filePath: "src/a.ts",
              content: "one",
              numLines: 1,
              startLine: 1,
              totalLines: 1,
              truncated: false,
            },
          },
        ],
      },
    ]);

    expect(screen.getByText("Read")).toBeInTheDocument();
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.queryByText("完成")).toBeNull();
    expect(screen.queryByText("one")).toBeNull();
  });

  it("shows the terminal service error instead of model retry and error notices", () => {
    renderChat([], {
      connection: {
        target: "agent-service",
        revision: 4,
        updatedAt: 1_000,
        status: "unavailable",
        attempt: 5,
        maxAttempts: 5,
        reason: "readiness-timeout",
      },
      retry: { kind: "network-error", attempt: 2, maxRetries: 5 },
      error: "模型请求失败",
    });

    expect(screen.getByText("本地 AI 服务暂不可用，请稍后重试")).toBeInTheDocument();
    expect(screen.queryByText(/正在重试 2\/5/)).toBeNull();
    expect(screen.queryByText("模型请求失败")).toBeNull();
  });

  it("shows the reconnect counter after the connection was established", () => {
    renderChat([], {
      connection: {
        target: "agent-service",
        revision: 4,
        updatedAt: 1_000,
        status: "reconnecting",
        attempt: 3,
        maxAttempts: 5,
        nextRetryAt: 2_000,
        reason: "worker-exit",
      },
    });

    expect(screen.getByText("本地 AI 服务未连接，正在重连 3/5")).toBeInTheDocument();
  });
});
