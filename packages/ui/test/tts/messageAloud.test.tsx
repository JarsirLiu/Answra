import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ConversationViewMessage } from "../../src/components/chat/conversationMessage";
import { ChatPanel } from "../../src/components/panels/ChatPanel";

const MESSAGE: ConversationViewMessage = {
  id: "message-9",
  role: "assistant",
  text: "你好，请先自我介绍。",
  images: [],
  status: "complete",
};

function renderChat(onAloud?: (messageId: string, text: string) => void): void {
  render(
    <ChatPanel
      attachments={[]}
      draft=""
      fileInputRef={createRef<HTMLInputElement>()}
      messages={[MESSAGE]}
      onAloud={onAloud}
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

describe("message read-aloud action", () => {
  it("passes the message id and body to the provided handler", () => {
    const onAloud = vi.fn();
    renderChat(onAloud);

    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "朗读" }));

    expect(onAloud).toHaveBeenCalledWith("message-9", "你好，请先自我介绍。");
  });

  it("does not offer read-aloud when the host has no speech support", () => {
    renderChat();

    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));

    expect(screen.queryByRole("menuitem", { name: "朗读" })).not.toBeInTheDocument();
  });
});
