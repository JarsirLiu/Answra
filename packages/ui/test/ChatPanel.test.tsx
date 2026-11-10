import type { AgentConnectionState } from "@answra/shared";
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
      error={options.error}
      retry={options.retry}
    />,
  );
}

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

  it("shows the connection state instead of model retry and error notices", () => {
    renderChat([], {
      connection: {
        target: "agent-service",
        revision: 4,
        updatedAt: 1_000,
        status: "reconnecting",
        attempt: 3,
        maxAttempts: 5,
        nextRetryAt: 2_000,
        reason: "readiness-timeout",
      },
      retry: { kind: "network-error", attempt: 2, maxRetries: 5 },
      error: "模型请求失败",
    });

    expect(screen.getByText("网络连接中断，正在重连 3/5")).toBeInTheDocument();
    expect(screen.queryByText(/正在重试 2\/5/)).toBeNull();
    expect(screen.queryByText("模型请求失败")).toBeNull();
  });
});
