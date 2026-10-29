import type { ConversationChange, ConversationMessage, DesktopBridge } from "@answra/shared";
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useReplyConversation } from "../src/app/useReplyConversation";

interface FakeStore {
  bridge: DesktopBridge;
  begin: (conversationId: string) => void;
  delta: (conversationId: string, delta: string) => void;
  finish: (conversationId: string) => void;
  /** 模拟答题会话的 ephemeral 清空，并发布实际的空快照。 */
  clear: (conversationId: string) => void;
}

function createFakeStore(): FakeStore {
  const listeners = new Set<(change: ConversationChange) => void>();
  const journal: ConversationChange[] = [];
  let revision = 0;
  let messages: ConversationMessage[] = [];

  const publish = (change: ConversationChange) => {
    revision = revisionOf(change);
    journal.push(change);
    for (const listener of listeners) listener(change);
  };

  return {
    bridge: {
      getConversationSnapshot: vi.fn(async (id: string) => ({
        conversationId: id,
        revision,
        messages: messages.map((message) => ({ ...message })),
      })),
      readConversationEvents: vi.fn(async (_id: string, after: number) =>
        journal.filter((item) => revisionOf(item) > after),
      ),
      onConversationChange: vi.fn((listener: (change: ConversationChange) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    } as unknown as DesktopBridge,
    begin: (conversationId) => {
      const user: ConversationMessage = {
        id: "user-1",
        role: "user",
        text: "这题选什么",
        images: [],
        status: "complete",
      };
      const assistant: ConversationMessage = {
        id: "run-1",
        role: "assistant",
        text: "",
        images: [],
        status: "streaming",
      };
      messages = [user, assistant];
      publish({
        type: "messages-appended",
        conversationId,
        revision: revision + 1,
        messages: messages.map((message) => ({ ...message })),
        activeRunId: "run-1",
      });
    },
    delta: (conversationId, text) => {
      const assistant = messages.find((message) => message.id === "run-1");
      if (assistant) assistant.text += text;
      publish({
        type: "event",
        event: {
          conversationId,
          revision: revision + 1,
          runId: "run-1",
          chunk: { type: "text-delta", id: "text-1", delta: text },
        },
      });
    },
    finish: (conversationId) => {
      const assistant = messages.find((message) => message.id === "run-1");
      if (!assistant) return;
      assistant.status = "complete";
      publish({
        type: "run-finished",
        conversationId,
        revision: revision + 1,
        runId: "run-1",
        message: { ...assistant },
      });
    },
    clear: (conversationId) => {
      messages = [];
      publish({
        type: "snapshot",
        snapshot: { conversationId, revision: revision + 1, messages: [] },
      });
    },
  };
}

function Harness({
  bridge,
  conversationId,
  enabled,
}: {
  bridge: DesktopBridge;
  conversationId?: string;
  enabled: boolean;
}) {
  const state = useReplyConversation(bridge, conversationId, enabled);
  return (
    <div data-testid="messages">
      {state.messages.map((message) => `${message.id}:${message.text}`).join("|")}
    </div>
  );
}

function revisionOf(change: ConversationChange): number {
  if (change.type === "event") return change.event.revision;
  return change.type === "snapshot" ? change.snapshot.revision : change.revision;
}

describe("useReplyConversation", () => {
  it("keeps the finished answer after the ephemeral session is cleared from the store", async () => {
    const store = createFakeStore();
    const { rerender } = render(
      <Harness bridge={store.bridge} conversationId={undefined} enabled={false} />,
    );

    const conversationId = "screenshot-1";
    await act(async () => {
      rerender(<Harness bridge={store.bridge} conversationId={conversationId} enabled={true} />);
    });
    await act(async () => {
      store.begin(conversationId);
      store.delta(conversationId, "答案：D");
      store.finish(conversationId);
      store.clear(conversationId);
    });

    // 完成态仍保持订阅：运行时清空快照后，展开详情依旧能读到本轮对话。
    await waitFor(() => expect(screen.getByTestId("messages")).toHaveTextContent("run-1:答案：D"));
  });

  it("shows an empty conversation when subscribing only after the run finished", async () => {
    const store = createFakeStore();
    const conversationId = "screenshot-2";
    store.begin(conversationId);
    store.delta(conversationId, "答案：D");
    store.finish(conversationId);
    store.clear(conversationId);

    // 回归守卫：这正是“只在展开时挂载”会踩到的空详情，说明订阅必须全程保持。
    await act(async () => {
      render(<Harness bridge={store.bridge} conversationId={conversationId} enabled={true} />);
    });
    await waitFor(() => expect(screen.getByTestId("messages")).toHaveTextContent(""));
    expect(screen.getByTestId("messages").textContent).toBe("");
  });
});
