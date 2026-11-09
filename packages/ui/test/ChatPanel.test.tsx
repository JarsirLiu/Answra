import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ConversationViewMessage } from "../src/components/chat/conversationMessage";
import { ChatPanel } from "../src/components/panels/ChatPanel";

function renderChat(messages: ConversationViewMessage[]): void {
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

    expect(screen.getByText("读取")).toBeInTheDocument();
    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
    expect(screen.queryByText("完成")).toBeNull();
  });
});
