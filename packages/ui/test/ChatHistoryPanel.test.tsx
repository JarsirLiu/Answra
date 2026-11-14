import type { ConversationSessionSummary } from "@answra/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatHistoryPanel } from "../src/components/panels/ChatHistoryPanel";

const sessions: ConversationSessionSummary[] = [
  {
    conversationId: "chat-1",
    scope: "conversation",
    title: "登录排查",
    messageCount: 3,
    createdAt: "2026-11-14T00:00:00.000Z",
    updatedAt: "2026-11-14T01:00:00.000Z",
  },
  {
    conversationId: "chat-2",
    scope: "conversation",
    title: "数据库迁移",
    messageCount: 1,
    createdAt: "2026-11-14T02:00:00.000Z",
    updatedAt: "2026-11-14T03:00:00.000Z",
  },
];

describe("ChatHistoryPanel", () => {
  it("resumes a session from the list", () => {
    const onResume = vi.fn();
    render(
      <ChatHistoryPanel
        activeConversationId="chat-1"
        onDelete={vi.fn(async () => {})}
        onResume={onResume}
        sessions={sessions}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "继续会话 chat-2" }));
    expect(onResume).toHaveBeenCalledWith("chat-2");
  });

  it("requires a second click before deleting", () => {
    const onDelete = vi.fn(async () => {});
    render(
      <ChatHistoryPanel
        activeConversationId="chat-1"
        onDelete={onDelete}
        onResume={vi.fn()}
        sessions={sessions}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "删除会话 chat-2" }));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认删除会话 chat-2" }));
    expect(onDelete).toHaveBeenCalledWith("chat-2");
  });

  it("shows the history error and empty state", () => {
    render(
      <ChatHistoryPanel
        activeConversationId="chat-1"
        error="读取会话历史失败"
        onDelete={vi.fn(async () => {})}
        onResume={vi.fn()}
        sessions={[]}
      />,
    );

    expect(screen.getByText("读取会话历史失败")).toBeInTheDocument();
    expect(screen.getByText(/还没有历史会话/)).toBeInTheDocument();
  });
});
