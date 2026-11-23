import type { ConversationMessage, DesktopBridge } from "@answra/shared";
import type {
  AgentLiveOnlyEvent,
  LiveFrame,
  SessionFrame,
  SessionItem,
} from "@answra/shared/schema";
import { SESSION_FRAME_SCHEMA_VERSION } from "@answra/shared/schema";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { useReplyConversation } from "../src/app/useReplyConversation";

interface FakeSession {
  lastSeq: number;
  messages: ConversationMessage[];
  frames: SessionFrame[];
}

interface FakeStore {
  bridge: DesktopBridge;
  begin: (conversationId: string) => void;
  delta: (conversationId: string, delta: string) => void;
  finish: (conversationId: string) => void;
  clear: (conversationId: string) => void;
}

function frame(
  conversationId: string,
  seq: number,
  item: Omit<SessionItem, "seq">,
  ids: { turnId?: string; messageId?: string } = {},
): SessionFrame {
  return {
    schemaVersion: SESSION_FRAME_SCHEMA_VERSION,
    sessionId: conversationId,
    seq,
    eventId: `${conversationId}:${seq}`,
    occurredAt: "2026-11-07T00:00:00.000Z",
    producerId: "test",
    ...(ids.turnId === undefined ? {} : { turnId: ids.turnId }),
    ...(ids.messageId === undefined ? {} : { messageId: ids.messageId }),
    event: { type: "session-item", item: { ...item, seq } },
  };
}

function createFakeStore(): FakeStore {
  const frameListeners = new Set<(frame: SessionFrame) => void>();
  const liveListeners = new Set<(frame: LiveFrame) => void>();
  const sessions = new Map<string, FakeSession>();
  const sessionOf = (id: string): FakeSession => {
    let session = sessions.get(id);
    if (!session) {
      session = { lastSeq: 0, messages: [], frames: [] };
      sessions.set(id, session);
    }
    return session;
  };
  const publishFrame = (id: string, item: Omit<SessionItem, "seq">): void => {
    const session = sessionOf(id);
    const frameEvent = frame(id, session.lastSeq + 1, item, {
      turnId: "turn-1",
      messageId: "run-1",
    });
    session.lastSeq = frameEvent.seq;
    session.frames.push(frameEvent);
    for (const listener of frameListeners) listener(frameEvent);
  };
  const publishLive = (id: string, event: AgentLiveOnlyEvent): void => {
    const item: LiveFrame = { sessionId: id, messageId: "run-1", event };
    for (const listener of liveListeners) listener(item);
  };
  return {
    bridge: {
      getConversationSnapshot: vi.fn(async (id: string) => {
        const session = sessionOf(id);
        return {
          conversationId: id,
          lastSeq: session.lastSeq,
          messages: session.messages.map((message) => ({ ...message })),
        };
      }),
      readSessionFrames: vi.fn(async (id: string, after: number) =>
        sessionOf(id).frames.filter((item) => item.seq > after),
      ),
      onSessionFrame: vi.fn((listener: (item: SessionFrame) => void) => {
        frameListeners.add(listener);
        return () => frameListeners.delete(listener);
      }),
      onLiveFrame: vi.fn((listener: (item: LiveFrame) => void) => {
        liveListeners.add(listener);
        return () => liveListeners.delete(listener);
      }),
    } as unknown as DesktopBridge,
    begin: (id) => {
      const session = sessionOf(id);
      session.messages = [
        { id: "user-1", role: "user", text: "这题选什么", images: [], status: "complete" },
        { id: "run-1", role: "assistant", text: "", images: [], status: "streaming" },
      ];
    },
    delta: (id, text) => {
      const session = sessionOf(id);
      const assistant = session.messages.find((message) => message.id === "run-1");
      if (assistant) assistant.text += text;
      publishLive(id, { type: "text-delta", partId: "text-1", delta: text });
    },
    finish: (id) => {
      const session = sessionOf(id);
      const assistant = session.messages.find((message) => message.id === "run-1");
      if (assistant) assistant.status = "complete";
      publishFrame(id, {
        itemId: "turn-1:end",
        status: "complete",
        createdAt: "2026-11-07T00:00:01.000Z",
        turnId: "turn-1",
        payload: { kind: "turn-end", stepCount: 1, toolCalls: 0 },
      });
    },
    clear: (id) => {
      // 清空同时重置 transcript 与 journal 游标：下一次订阅看到的是真正的空会话。
      const session = sessionOf(id);
      session.messages = [];
      session.frames = [];
      session.lastSeq = 0;
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

async function runRound(
  store: FakeStore,
  rerender: (element: ReactElement) => void,
  conversationId: string,
  answer: string,
) {
  store.begin(conversationId);
  await act(async () =>
    rerender(<Harness bridge={store.bridge} conversationId={conversationId} enabled={true} />),
  );
  await act(async () => {
    store.delta(conversationId, answer);
    store.finish(conversationId);
    store.clear(conversationId);
  });
}

describe("useReplyConversation", () => {
  it("keeps the finished answer after the ephemeral session is cleared", async () => {
    const store = createFakeStore();
    const { rerender } = render(
      <Harness bridge={store.bridge} conversationId={undefined} enabled={false} />,
    );
    await runRound(store, rerender, "screenshot-1", "答案：D");
    await waitFor(() => expect(screen.getByTestId("messages")).toHaveTextContent("run-1:答案：D"));
  });

  it("shows an empty conversation when subscribing only after the run finished", async () => {
    const store = createFakeStore();
    store.begin("screenshot-2");
    store.delta("screenshot-2", "答案：D");
    store.finish("screenshot-2");
    store.clear("screenshot-2");
    render(<Harness bridge={store.bridge} conversationId="screenshot-2" enabled={true} />);
    await waitFor(() => expect(screen.getByTestId("messages")).toHaveTextContent(""));
    expect(screen.getByTestId("messages").textContent).toBe("");
  });

  it("starts each new answer round from a clean panel", async () => {
    const store = createFakeStore();
    const { rerender } = render(
      <Harness bridge={store.bridge} conversationId={undefined} enabled={false} />,
    );
    await runRound(store, rerender, "screenshot-1", "答案：D");
    await waitFor(() => expect(screen.getByTestId("messages")).toHaveTextContent("run-1:答案：D"));
    await runRound(store, rerender, "screenshot-2", "答案：B");
    expect(screen.getByTestId("messages").textContent).toContain("答案：B");
    expect(screen.getByTestId("messages").textContent).not.toContain("答案：D");
  });

  it("ignores late events from a previous round after switching", async () => {
    const store = createFakeStore();
    const { rerender } = render(
      <Harness bridge={store.bridge} conversationId={undefined} enabled={false} />,
    );
    await runRound(store, rerender, "screenshot-1", "答案：D");
    await act(async () =>
      rerender(<Harness bridge={store.bridge} conversationId="screenshot-2" enabled={true} />),
    );
    await act(async () => store.delta("screenshot-1", "迟到的旧轮增量"));
    expect(screen.getByTestId("messages").textContent).toBe("");
  });
});
