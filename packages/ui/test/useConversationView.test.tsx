import type { ConversationSnapshot, DesktopBridge } from "@answra/shared";
import type { AgentEventEnvelope } from "@answra/shared/schema";
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useConversationView } from "../src/app/useConversationView";

function envelope(revision: number, delta: string): AgentEventEnvelope {
  return {
    schemaVersion: 1,
    eventId: `event-${revision}`,
    conversationId: "conversation-1",
    runId: "run-1",
    attemptId: "run-1:attempt:1",
    sequence: revision,
    aggregateRevision: revision,
    producerId: "test",
    occurredAt: "2026-11-07T00:00:00.000Z",
    event: { type: "text-delta", partId: "part-1", delta },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function Harness({
  bridge,
  onApplySnapshot,
}: {
  bridge: DesktopBridge;
  onApplySnapshot?: (apply: (snapshot: ConversationSnapshot) => void) => void;
}) {
  const { view, applySnapshot } = useConversationView(bridge, "conversation-1");
  onApplySnapshot?.(applySnapshot);
  return <output>{view.messages.map((message) => message.text).join("|")}</output>;
}

describe("useConversationView recovery", () => {
  it("buffers live events during initialization, replays in order, and fills revision gaps", async () => {
    const firstRead = deferred<AgentEventEnvelope[]>();
    const listeners = new Set<(event: AgentEventEnvelope) => void>();
    const readConversationEvents = vi
      .fn()
      .mockImplementationOnce(() => firstRead.promise)
      .mockImplementation(async (_id: string, afterRevision: number) =>
        [envelope(2, "B"), envelope(3, "C")].filter(
          (event) => event.aggregateRevision > afterRevision,
        ),
      );
    const snapshot: ConversationSnapshot = {
      conversationId: "conversation-1",
      eventRevision: 0,
      activeRunId: "run-1",
      messages: [{ id: "run-1", role: "assistant", text: "", images: [], status: "streaming" }],
    };
    const bridge = {
      getConversationSnapshot: vi.fn(async () => snapshot),
      readConversationEvents,
      onConversationEvent: vi.fn((listener: (event: AgentEventEnvelope) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    } as unknown as DesktopBridge;

    render(<Harness bridge={bridge} />);
    await waitFor(() => expect(readConversationEvents).toHaveBeenCalledWith("conversation-1", 0));
    act(() => {
      for (const listener of listeners) listener(envelope(3, "C"));
    });
    await act(async () => firstRead.resolve([envelope(1, "A")]));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("ABC"));
    expect(readConversationEvents).toHaveBeenLastCalledWith("conversation-1", 1);
  });

  it("drains buffered live events when a later snapshot advances past a missing revision", async () => {
    const listeners = new Set<(event: AgentEventEnvelope) => void>();
    let applySnapshot: ((snapshot: ConversationSnapshot) => void) | undefined;
    const bridge = {
      getConversationSnapshot: vi.fn(
        async (): Promise<ConversationSnapshot> => ({
          conversationId: "conversation-1",
          eventRevision: 0,
          activeRunId: "run-1",
          messages: [
            { id: "run-1", role: "assistant", text: "A", images: [], status: "streaming" },
          ],
        }),
      ),
      readConversationEvents: vi.fn(async () => []),
      onConversationEvent: vi.fn((listener: (event: AgentEventEnvelope) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    } as unknown as DesktopBridge;

    render(
      <Harness
        bridge={bridge}
        onApplySnapshot={(apply) => {
          applySnapshot = apply;
        }}
      />,
    );
    await waitFor(() => expect(bridge.readConversationEvents).toHaveBeenCalled());
    act(() => {
      for (const listener of listeners) listener(envelope(2, "B"));
    });
    await waitFor(() =>
      expect(bridge.readConversationEvents).toHaveBeenLastCalledWith("conversation-1", 0),
    );

    act(() => {
      applySnapshot?.({
        conversationId: "conversation-1",
        eventRevision: 1,
        activeRunId: "run-1",
        messages: [{ id: "run-1", role: "assistant", text: "A", images: [], status: "streaming" }],
      });
    });

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("AB"));
  });

  it("keeps a pushed transcript snapshot when an older initialization snapshot resolves later", async () => {
    const initialSnapshot = deferred<ConversationSnapshot>();
    let publishSnapshot: ((snapshot: ConversationSnapshot) => void) | undefined;
    const bridge = {
      getConversationSnapshot: vi.fn(() => initialSnapshot.promise),
      onConversationEvent: vi.fn(() => () => undefined),
      onConversationSnapshot: vi.fn((listener: (snapshot: ConversationSnapshot) => void) => {
        publishSnapshot = listener;
        return () => {
          publishSnapshot = undefined;
        };
      }),
    } as unknown as DesktopBridge;

    render(<Harness bridge={bridge} />);
    await waitFor(() => expect(publishSnapshot).toBeTypeOf("function"));
    act(() =>
      publishSnapshot?.({
        conversationId: "conversation-1",
        eventRevision: 0,
        messages: [
          { id: "user-1", role: "user", text: "已结算语音", images: [], status: "complete" },
        ],
      }),
    );
    await act(async () => {
      initialSnapshot.resolve({ conversationId: "conversation-1", eventRevision: 0, messages: [] });
    });

    expect(screen.getByRole("status")).toHaveTextContent("已结算语音");
  });

  it("replays live events when the pushed run snapshot arrives after them", async () => {
    const listeners = new Set<(event: AgentEventEnvelope) => void>();
    let publishSnapshot: ((snapshot: ConversationSnapshot) => void) | undefined;
    let eventHistoryAvailable = false;
    const runEvent = envelope(1, "A");
    const bridge = {
      getConversationSnapshot: vi.fn(async () => ({
        conversationId: "conversation-1",
        eventRevision: 0,
        messages: [],
      })),
      readConversationEvents: vi.fn(async (_id: string, afterRevision: number) =>
        eventHistoryAvailable && runEvent.aggregateRevision > afterRevision ? [runEvent] : [],
      ),
      onConversationEvent: vi.fn((listener: (event: AgentEventEnvelope) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      onConversationSnapshot: vi.fn((listener: (snapshot: ConversationSnapshot) => void) => {
        publishSnapshot = listener;
        return () => {
          publishSnapshot = undefined;
        };
      }),
    } as unknown as DesktopBridge;

    render(<Harness bridge={bridge} />);
    await waitFor(() =>
      expect(bridge.readConversationEvents).toHaveBeenCalledWith("conversation-1", 0),
    );

    act(() => {
      for (const listener of listeners) listener(runEvent);
    });
    eventHistoryAvailable = true;
    act(() =>
      publishSnapshot?.({
        conversationId: "conversation-1",
        eventRevision: 0,
        activeRunId: "run-1",
        messages: [{ id: "run-1", role: "assistant", text: "", images: [], status: "streaming" }],
      }),
    );

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("A"));
    expect(bridge.readConversationEvents).toHaveBeenLastCalledWith("conversation-1", 0);
  });
});
