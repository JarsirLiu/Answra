import type {
  ConversationSessionSummary,
  ConversationSnapshot,
  DesktopBridge,
} from "@answra/shared";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useChatSessions } from "../src/app/useChatSessions";

const summary: ConversationSessionSummary = {
  conversationId: "chat-old",
  scope: "conversation",
  title: "旧会话",
  messageCount: 1,
  createdAt: "2026-11-14T00:00:00.000Z",
  updatedAt: "2026-11-14T01:00:00.000Z",
};

function snapshot(conversationId: string): ConversationSnapshot {
  return { conversationId, eventRevision: 0, messages: [] };
}

describe("useChatSessions", () => {
  it("loads history and creates a new chat conversation", async () => {
    const createConversation = vi.fn(async (conversationId: string) => snapshot(conversationId));
    const bridge = {
      listConversationSessions: vi.fn(async () => [summary]),
      createConversation,
      deleteConversationSession: vi.fn(async () => {}),
    } as unknown as DesktopBridge;

    const { result } = renderHook(() => useChatSessions(bridge));
    await waitFor(() => expect(result.current.sessions).toEqual([summary]));

    await act(async () => {
      await result.current.newConversation();
    });

    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(createConversation.mock.calls[0]?.[0]).toMatch(/^chat-/);
    expect(result.current.activeConversationId).toMatch(/^chat-/);
  });

  it("deletes the active conversation and creates a replacement", async () => {
    const createConversation = vi.fn(async (conversationId: string) => snapshot(conversationId));
    const deleteConversationSession = vi.fn(async () => {});
    const bridge = {
      listConversationSessions: vi.fn(async () => [summary]),
      createConversation,
      deleteConversationSession,
    } as unknown as DesktopBridge;

    const { result } = renderHook(() => useChatSessions(bridge));
    await waitFor(() => expect(result.current.sessions).toEqual([summary]));
    act(() => result.current.resumeConversation("chat-old"));

    await act(async () => {
      await result.current.deleteConversation("chat-old");
    });

    expect(deleteConversationSession).toHaveBeenCalledWith("chat-old");
    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(result.current.activeConversationId).toMatch(/^chat-/);
  });
});
