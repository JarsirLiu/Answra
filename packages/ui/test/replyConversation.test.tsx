import type { ConversationMessage, DesktopBridge } from "@answra/shared";
import type { AgentEventEnvelope } from "@answra/shared/schema";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { useReplyConversation } from "../src/app/useReplyConversation";

interface FakeSession {
  revision: number;
  messages: ConversationMessage[];
  events: AgentEventEnvelope[];
}

interface FakeStore {
  bridge: DesktopBridge;
  begin: (conversationId: string) => void;
  delta: (conversationId: string, delta: string) => void;
  finish: (conversationId: string) => void;
  clear: (conversationId: string) => void;
}

function envelope(
  conversationId: string,
  revision: number,
  event: AgentEventEnvelope["event"],
): AgentEventEnvelope {
  return {
    schemaVersion: 1,
    eventId: `event-${revision}`,
    conversationId,
    runId: "run-1",
    attemptId: "run-1:attempt:1",
    sequence: revision,
    aggregateRevision: revision,
    producerId: "test",
    occurredAt: "2026-11-07T00:00:00.000Z",
    event,
  };
}

function createFakeStore(): FakeStore {
  const listeners = new Set<(event: AgentEventEnvelope) => void>();
  const sessions = new Map<string, FakeSession>();
  const sessionOf = (id: string): FakeSession => {
    let session = sessions.get(id);
    if (!session) {
      session = { revision: 0, messages: [], events: [] };
      sessions.set(id, session);
    }
    return session;
  };
  const publish = (id: string, event: AgentEventEnvelope["event"]) => {
    const session = sessionOf(id);
    const revision = session.revision + 1;
    const item = envelope(id, revision, event);
    session.revision = revision;
    session.events.push(item);
    for (const listener of listeners) listener(item);
  };
  return {
    bridge: {
      getConversationSnapshot: vi.fn(async (id: string) => {
        const session = sessionOf(id);
        return {
          conversationId: id,
          revision: session.revision,
          messages: session.messages.map((message) => ({ ...message })),
        };
      }),
      readConversationEvents: vi.fn(async (id: string, after: number) =>
        sessionOf(id).events.filter((event) => event.aggregateRevision > after),
      ),
      onConversationEvent: vi.fn((listener: (event: AgentEventEnvelope) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    } as unknown as DesktopBridge,
    begin: (id) => {
      const session = sessionOf(id);
      session.revision += 1;
      session.messages = [
        { id: "user-1", role: "user", text: "这题选什么", images: [], status: "complete" },
        { id: "run-1", role: "assistant", text: "", images: [], status: "streaming" },
      ];
    },
    delta: (id, text) => {
      const session = sessionOf(id);
      const assistant = session.messages.find((message) => message.id === "run-1");
      if (assistant) assistant.text += text;
      publish(id, { type: "text-delta", partId: "text-1", delta: text });
    },
    finish: (id) => {
      const session = sessionOf(id);
      const assistant = session.messages.find((message) => message.id === "run-1");
      if (assistant) assistant.status = "complete";
      publish(id, { type: "run-state-changed", state: "completed", attempt: 1 });
    },
    clear: (id) => {
      const session = sessionOf(id);
      session.messages = [];
      session.revision += 1;
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
