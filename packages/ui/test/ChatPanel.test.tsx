import type {
  AgentConnectionState,
  ContextCompactionBoundary,
  ContextCompactionStatus,
  ConversationSessionSummary,
} from "@answra/shared";
import { fireEvent, render, screen } from "@testing-library/react";
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
  compactionBoundaries?: readonly ContextCompactionBoundary[];
  error?: string;
  retry?: ConversationRetry;
  sessions?: readonly ConversationSessionSummary[];
  onClear?: () => void;
  onNewConversation?: () => void;
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
      compactionBoundaries={options.compactionBoundaries}
      error={options.error}
      retry={options.retry}
      sessions={options.sessions}
      onClear={options.onClear}
      onNewConversation={options.onNewConversation}
    />,
  );
}

describe("ChatPanel context compaction", () => {
  it("shows automatic compaction progress without a model error", () => {
    renderChat([], {
      contextCompaction: {
        state: "started",
        trigger: "auto",
        startedAt: "2026-11-13T10:00:00.000Z",
        updatedAt: "2026-11-13T10:00:00.000Z",
      },
    });

    expect(screen.getByText("开始自动压缩上下文…")).toBeInTheDocument();
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

    expect(screen.getByText("上下文压缩完成")).toBeInTheDocument();
    expect(screen.queryByText(/条消息/)).not.toBeInTheDocument();

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

  it("shows the compaction boundary metadata and expands its summary", () => {
    renderChat(
      [
        {
          id: "message-1",
          role: "user",
          text: "question",
          status: "complete",
          images: [],
        },
      ],
      {
        compactionBoundaries: [
          {
            id: "compaction-1",
            throughMessageId: "message-1",
            createdAt: "2026-11-14T10:00:00.000Z",
            summary: "## 当前目标\n继续实现压缩",
            summarizedMessages: 8,
            instructions: "保留数据库迁移决定",
          },
        ],
      },
    );

    expect(screen.getByText("上下文已压缩")).toBeInTheDocument();
    expect(screen.getByText("已摘要 8 条消息")).toBeInTheDocument();
    expect(screen.getByText("摘要重点：“保留数据库迁移决定”")).toBeInTheDocument();
    expect(screen.queryByText(/继续实现压缩/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "展开摘要" }));

    expect(screen.getByText(/继续实现压缩/)).toBeInTheDocument();
    expect(screen.queryByText("已摘要 8 条消息")).not.toBeInTheDocument();
  });
});

describe("ChatPanel header", () => {
  it("keeps only history, new conversation, and clear actions", () => {
    renderChat([], {
      sessions: [],
      onClear: vi.fn(),
      onNewConversation: vi.fn(),
    });

    expect(screen.getByRole("button", { name: "查看会话历史" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建对话" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "清空对话历史" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "压缩上下文" })).not.toBeInTheDocument();
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
