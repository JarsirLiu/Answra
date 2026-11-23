import type { ConversationSnapshot, DesktopBridge } from "@answra/shared";
import type { SessionFrame, SessionItem } from "@answra/shared/schema";
import { SESSION_FRAME_SCHEMA_VERSION } from "@answra/shared/schema";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useConversationView } from "../src/app/useConversationView";

function frame(
  seq: number,
  item: Omit<SessionItem, "seq">,
  ids: { turnId?: string; messageId?: string } = {},
): SessionFrame {
  return {
    schemaVersion: SESSION_FRAME_SCHEMA_VERSION,
    sessionId: "conversation-1",
    seq,
    eventId: `conversation-1:${seq}`,
    occurredAt: "2026-11-07T00:00:00.000Z",
    producerId: "test",
    ...(ids.turnId === undefined ? {} : { turnId: ids.turnId }),
    ...(ids.messageId === undefined ? {} : { messageId: ids.messageId }),
    event: { type: "session-item", item: { ...item, seq } },
  };
}

function textItem(text = "答案"): Omit<SessionItem, "seq"> {
  return {
    itemId: `text-${text}`,
    status: "complete",
    createdAt: "2026-11-07T00:00:00.000Z",
    turnId: "turn-1",
    messageId: "run-1",
    payload: { kind: "text", text },
  };
}

function toolCallItem(toolCallId = "tool-1"): Omit<SessionItem, "seq"> {
  return {
    itemId: toolCallId,
    status: "complete",
    createdAt: "2026-11-07T00:00:00.000Z",
    turnId: "turn-1",
    messageId: "run-1",
    payload: { kind: "tool-call", toolCallId, toolName: "workspace.read", input: { path: "a.ts" } },
  };
}

function toolResultItem(toolCallId = "tool-1"): Omit<SessionItem, "seq"> {
  return {
    itemId: `${toolCallId}:result`,
    status: "complete",
    createdAt: "2026-11-07T00:00:00.000Z",
    turnId: "turn-1",
    messageId: "run-1",
    payload: { kind: "tool-result", toolCallId, outcome: "output", output: "ok" },
  };
}

function turnEndItem(
  turnId = "turn-1",
  status: "complete" | "interrupted" | "failed" = "complete",
): Omit<SessionItem, "seq"> {
  return {
    itemId: `${turnId}:end`,
    status,
    createdAt: "2026-11-07T00:00:00.000Z",
    turnId,
    payload: {
      kind: "turn-end",
      stepCount: 1,
      toolCalls: 0,
      ...(status === "interrupted"
        ? { interruption: { reason: "cancelled" as const, at: "2026-11-07T00:00:00.000Z" } }
        : {}),
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 输出游标与消息正文：游标用于断言帧顺序，正文用于断言快照合并。 */
function Harness({
  bridge,
  onApplySnapshot,
}: {
  bridge: DesktopBridge;
  onApplySnapshot?: (apply: (snapshot: ConversationSnapshot) => void) => void;
}) {
  const { view, applySnapshot } = useConversationView(bridge, "conversation-1");
  onApplySnapshot?.(applySnapshot);
  return (
    <output>{`${view.lastSeq}:${view.messages.map((message) => message.text).join("|")}`}</output>
  );
}

function subscribeFrames(listeners: Set<(frame: SessionFrame) => void>) {
  return (listener: (frame: SessionFrame) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
}

describe("useConversationView recovery", () => {
  it("buffers durable frames during initialization, applies them in seq order, and re-reads the gap", async () => {
    const firstRead = deferred<SessionFrame[]>();
    const listeners = new Set<(frame: SessionFrame) => void>();
    const history = [frame(3, textItem())];
    const readSessionFrames = vi
      .fn()
      .mockImplementationOnce(() => firstRead.promise)
      .mockImplementation(async (_id: string, afterSeq: number) =>
        history.filter((item) => item.seq > afterSeq),
      );
    const snapshot: ConversationSnapshot = {
      conversationId: "conversation-1",
      lastSeq: 0,
      activeMessageId: "run-1",
      messages: [{ id: "run-1", role: "assistant", text: "", images: [], status: "streaming" }],
    };
    const bridge = {
      getConversationSnapshot: vi.fn(async () => snapshot),
      readSessionFrames,
      onSessionFrame: subscribeFrames(listeners),
      onLiveFrame: vi.fn(() => () => undefined),
    } as unknown as DesktopBridge;

    render(<Harness bridge={bridge} />);
    await waitFor(() => expect(readSessionFrames).toHaveBeenCalledWith("conversation-1", 0));
    act(() => {
      for (const listener of listeners)
        listener(
          frame(3, turnEndItem(), {
            turnId: "turn-1",
            messageId: "run-1",
          }),
        );
    });
    await act(async () =>
      firstRead.resolve([
        frame(1, toolCallItem(), {
          turnId: "turn-1",
          messageId: "run-1",
        }),
        frame(2, toolResultItem(), {
          turnId: "turn-1",
          messageId: "run-1",
        }),
      ]),
    );

    // 初始化期间到达的第 3 帧被记为缺口，必须整段重读后按 seq 应用。
    await waitFor(() => expect(readSessionFrames).toHaveBeenLastCalledWith("conversation-1", 2));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("3:"));
  });

  it("drains buffered durable frames when a later snapshot advances past a missing seq", async () => {
    const listeners = new Set<(frame: SessionFrame) => void>();
    let applySnapshot: ((snapshot: ConversationSnapshot) => void) | undefined;
    const history: SessionFrame[] = [];
    const bridge = {
      getConversationSnapshot: vi.fn(
        async (): Promise<ConversationSnapshot> => ({
          conversationId: "conversation-1",
          lastSeq: 0,
          activeMessageId: "run-1",
          messages: [
            { id: "run-1", role: "assistant", text: "A", images: [], status: "streaming" },
          ],
        }),
      ),
      readSessionFrames: vi.fn(async (_id: string, afterSeq: number) =>
        history.filter((item) => item.seq > afterSeq),
      ),
      onSessionFrame: subscribeFrames(listeners),
      onLiveFrame: vi.fn(() => () => undefined),
    } as unknown as DesktopBridge;

    render(
      <Harness
        bridge={bridge}
        onApplySnapshot={(apply) => {
          applySnapshot = apply;
        }}
      />,
    );
    await waitFor(() => expect(bridge.readSessionFrames).toHaveBeenCalled());
    act(() => {
      for (const listener of listeners)
        listener(
          frame(2, toolCallItem(), {
            turnId: "turn-1",
            messageId: "run-1",
          }),
        );
    });
    // 游标停在 0 时第 2 帧是缺口：只能整段重读，历史里还没有第 1 帧。
    await waitFor(() =>
      expect(bridge.readSessionFrames).toHaveBeenLastCalledWith("conversation-1", 0),
    );

    history.push(
      frame(1, toolCallItem(), {
        turnId: "turn-1",
        messageId: "run-1",
      }),
      frame(2, toolResultItem(), {
        turnId: "turn-1",
        messageId: "run-1",
      }),
    );
    act(() => {
      applySnapshot?.({
        conversationId: "conversation-1",
        lastSeq: 1,
        activeMessageId: "run-1",
        messages: [{ id: "run-1", role: "assistant", text: "A", images: [], status: "streaming" }],
      });
    });

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("2:A"));
  });

  it("keeps a pushed transcript snapshot when an older initialization snapshot resolves later", async () => {
    const initialSnapshot = deferred<ConversationSnapshot>();
    let publishSnapshot: ((snapshot: ConversationSnapshot) => void) | undefined;
    const bridge = {
      getConversationSnapshot: vi.fn(() => initialSnapshot.promise),
      onSessionFrame: vi.fn(() => () => undefined),
      onLiveFrame: vi.fn(() => () => undefined),
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
        lastSeq: 0,
        messages: [
          { id: "user-1", role: "user", text: "已结算语音", images: [], status: "complete" },
        ],
      }),
    );
    await act(async () => {
      initialSnapshot.resolve({
        conversationId: "conversation-1",
        lastSeq: 0,
        messages: [],
      });
    });

    expect(screen.getByRole("status")).toHaveTextContent("已结算语音");
  });

  it("re-reads durable frames after a pushed turn snapshot arrives", async () => {
    let publishSnapshot: ((snapshot: ConversationSnapshot) => void) | undefined;
    const history: SessionFrame[] = [];
    const bridge = {
      getConversationSnapshot: vi.fn(async () => ({
        conversationId: "conversation-1",
        lastSeq: 0,
        messages: [],
      })),
      readSessionFrames: vi.fn(async (_id: string, afterSeq: number) =>
        history.filter((item) => item.seq > afterSeq),
      ),
      onSessionFrame: vi.fn(() => () => undefined),
      onLiveFrame: vi.fn(() => () => undefined),
      onConversationSnapshot: vi.fn((listener: (snapshot: ConversationSnapshot) => void) => {
        publishSnapshot = listener;
        return () => {
          publishSnapshot = undefined;
        };
      }),
    } as unknown as DesktopBridge;

    render(<Harness bridge={bridge} />);
    await waitFor(() => expect(bridge.readSessionFrames).toHaveBeenCalledWith("conversation-1", 0));

    history.push(
      frame(1, toolCallItem(), {
        turnId: "turn-1",
        messageId: "run-1",
      }),
    );
    act(() =>
      publishSnapshot?.({
        conversationId: "conversation-1",
        lastSeq: 0,
        activeTurnId: "turn-1",
        activeMessageId: "run-1",
        messages: [{ id: "run-1", role: "assistant", text: "", images: [], status: "streaming" }],
      }),
    );

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("1:"));
    expect(bridge.readSessionFrames).toHaveBeenLastCalledWith("conversation-1", 0);
  });

  it("resolves in-flight turn waiters as aborted when the view is cleared", async () => {
    const bridge = {
      getConversationSnapshot: vi.fn(async () => ({
        conversationId: "conversation-1",
        lastSeq: 0,
        messages: [],
      })),
      readSessionFrames: vi.fn(async () => []),
    } as unknown as DesktopBridge;
    const { result } = renderHook(() => useConversationView(bridge, "conversation-1"));

    const outcome = result.current.waitForOutcome("turn-1");
    act(() => result.current.clear());

    await expect(outcome).resolves.toBe("aborted");
  });

  it("resets the frame cursor when cleared so a restarted worker's frames apply again", async () => {
    const listeners = new Set<(frame: SessionFrame) => void>();
    const bridge = {
      getConversationSnapshot: vi.fn(async () => ({
        conversationId: "conversation-1",
        lastSeq: 0,
        messages: [],
      })),
      readSessionFrames: vi.fn(async () => []),
      onSessionFrame: subscribeFrames(listeners),
      onLiveFrame: vi.fn(() => () => undefined),
    } as unknown as DesktopBridge;
    const { result } = renderHook(() => useConversationView(bridge, "conversation-1"));
    await waitFor(() => expect(listeners.size).toBe(1));

    act(() => {
      for (const listener of listeners) listener(frame(1, toolCallItem(), { turnId: "turn-1" }));
    });
    await waitFor(() => expect(result.current.view.lastSeq).toBe(1));

    act(() => result.current.clear());
    expect(result.current.view.lastSeq).toBe(0);

    act(() => {
      for (const listener of listeners) listener(frame(1, toolCallItem(), { turnId: "turn-1" }));
    });
    await waitFor(() => expect(result.current.view.lastSeq).toBe(1));
  });
});
