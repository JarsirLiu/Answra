import type { ConversationChange, ConversationMessage, DesktopBridge } from "@answra/shared";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { useReplyConversation } from "../src/app/useReplyConversation";

interface FakeSession {
  revision: number;
  messages: ConversationMessage[];
  journal: ConversationChange[];
}

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
  const sessions = new Map<string, FakeSession>();

  const sessionOf = (conversationId: string): FakeSession => {
    let session = sessions.get(conversationId);
    if (!session) {
      session = { revision: 0, messages: [], journal: [] };
      sessions.set(conversationId, session);
    }
    return session;
  };

  const publish = (conversationId: string, change: ConversationChange) => {
    const session = sessionOf(conversationId);
    session.revision = revisionOf(change);
    session.journal.push(change);
    for (const listener of listeners) listener(change);
  };

  return {
    bridge: {
      getConversationSnapshot: vi.fn(async (id: string) => {
        const session = sessions.get(id);
        return {
          conversationId: id,
          revision: session?.revision ?? 0,
          messages: session?.messages.map((message) => ({ ...message })) ?? [],
        };
      }),
      readConversationEvents: vi.fn(async (id: string, after: number) =>
        (sessions.get(id)?.journal ?? []).filter((item) => revisionOf(item) > after),
      ),
      onConversationChange: vi.fn((listener: (change: ConversationChange) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    } as unknown as DesktopBridge,
    begin: (conversationId) => {
      const session = sessionOf(conversationId);
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
      session.messages = [user, assistant];
      publish(conversationId, {
        type: "messages-appended",
        conversationId,
        revision: session.revision + 1,
        messages: session.messages.map((message) => ({ ...message })),
        activeRunId: "run-1",
      });
    },
    delta: (conversationId, text) => {
      const session = sessionOf(conversationId);
      const assistant = session.messages.find((message) => message.id === "run-1");
      if (assistant) assistant.text += text;
      publish(conversationId, {
        type: "event",
        event: {
          conversationId,
          revision: session.revision + 1,
          runId: "run-1",
          chunk: { type: "text-delta", id: "text-1", delta: text },
        },
      });
    },
    finish: (conversationId) => {
      const session = sessionOf(conversationId);
      const assistant = session.messages.find((message) => message.id === "run-1");
      if (!assistant) return;
      assistant.status = "complete";
      publish(conversationId, {
        type: "run-finished",
        conversationId,
        revision: session.revision + 1,
        runId: "run-1",
        message: { ...assistant },
      });
    },
    clear: (conversationId) => {
      const session = sessionOf(conversationId);
      session.messages = [];
      publish(conversationId, {
        type: "snapshot",
        snapshot: { conversationId, revision: session.revision + 1, messages: [] },
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

async function runRound(
  store: FakeStore,
  rerender: (element: ReactElement) => void,
  conversationId: string,
  answer: string,
) {
  await act(async () => {
    rerender(<Harness bridge={store.bridge} conversationId={conversationId} enabled={true} />);
  });
  await act(async () => {
    store.begin(conversationId);
    store.delta(conversationId, answer);
    store.finish(conversationId);
    store.clear(conversationId);
  });
}

describe("useReplyConversation", () => {
  it("keeps the finished answer after the ephemeral session is cleared from the store", async () => {
    const store = createFakeStore();
    const { rerender } = render(
      <Harness bridge={store.bridge} conversationId={undefined} enabled={false} />,
    );

    const conversationId = "screenshot-1";
    await runRound(store, rerender, conversationId, "答案：D");

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

  it("starts each new answer round from a clean panel and streams only the new round", async () => {
    const store = createFakeStore();
    const { rerender } = render(
      <Harness bridge={store.bridge} conversationId={undefined} enabled={false} />,
    );

    await runRound(store, rerender, "screenshot-1", "答案：D");
    await waitFor(() => expect(screen.getByTestId("messages")).toHaveTextContent("run-1:答案：D"));

    // 新一轮答题（新的 ephemeral 会话 id，revision 重新从 1 计数）：
    // 面板必须归零重新累积，而不是滞留上一轮答案或叠加两轮内容。
    await runRound(store, rerender, "screenshot-2", "答案：B");

    expect(screen.getByTestId("messages")).toHaveTextContent("run-1:");
    expect(screen.getByTestId("messages").textContent).toContain("答案：B");
    expect(screen.getByTestId("messages").textContent).not.toContain("答案：D");
  });

  it("ignores late events of a previous round after switching to a new round", async () => {
    const store = createFakeStore();
    const { rerender } = render(
      <Harness bridge={store.bridge} conversationId={undefined} enabled={false} />,
    );

    await runRound(store, rerender, "screenshot-1", "答案：D");

    await act(async () => {
      rerender(<Harness bridge={store.bridge} conversationId="screenshot-2" enabled={true} />);
    });
    // 换会话后旧轮的迟到事件按 conversationId 过滤，不得写入新面板。
    await act(async () => {
      store.delta("screenshot-1", "迟到的旧轮增量");
    });

    expect(screen.getByTestId("messages").textContent).toBe("");
  });
});
