import type { ConversationModelConfig, ConversationSnapshot } from "@answra/shared";
import { describe, expect, it, vi } from "vitest";
import { CodingSession, type CodingSessionHost } from "../../src/session/codingSession";

const model: ConversationModelConfig = {
  chat: { baseUrl: "http://127.0.0.1:1234/v1", model: "chat", auth: "local" },
  answer: { baseUrl: "http://127.0.0.1:1234/v1", model: "answer", auth: "local" },
};

const nextModel: ConversationModelConfig = {
  chat: { baseUrl: "http://127.0.0.1:1234/v1", model: "next-chat", auth: "local" },
  answer: { baseUrl: "http://127.0.0.1:1234/v1", model: "next-answer", auth: "local" },
};

const snapshot: ConversationSnapshot = {
  conversationId: "conversation-1",
  eventRevision: 0,
  messages: [],
};

function createHost(overrides: Partial<CodingSessionHost> = {}): CodingSessionHost {
  return {
    configure: vi.fn(),
    createConversation: vi.fn(async () => snapshot),
    getSnapshot: vi.fn(async () => snapshot),
    listSessions: vi.fn(async () => ({ items: [] })),
    deleteSession: vi.fn(async () => {}),
    clearConversation: vi.fn(async () => snapshot),
    compactConversation: vi.fn(async () => ({
      result: { status: "compacted" as const },
      snapshot,
    })),
    send: vi.fn(async () => ({ runId: "run-1" })),
    enqueue: vi.fn(async () => ({
      queueId: "queue-1",
      status: "started" as const,
      position: 0 as const,
      runId: "run-1",
      snapshot,
    })),
    waitForQueueStart: vi.fn(async (conversationId: string, queueId: string) => ({
      queueId,
      runId: "run-1",
      snapshot: { ...snapshot, conversationId },
    })),
    cancel: vi.fn(),
    waitForRun: vi.fn(async () => {}),
    dispose: vi.fn(),
    ...overrides,
  };
}

function createSession(host: CodingSessionHost): CodingSession {
  return new CodingSession({
    host,
    conversationId: "conversation-1",
    model,
    accessToken: "token",
  });
}

describe("CodingSession", () => {
  it("opens by configuring the host before creating the conversation", async () => {
    const order: string[] = [];
    const host = createHost({
      configure: vi.fn(() => {
        order.push("configure");
      }),
      createConversation: vi.fn(async () => {
        order.push("create");
        return snapshot;
      }),
    });
    const session = createSession(host);

    await session.open();
    await session.open();

    expect(order).toEqual(["configure", "create"]);
    expect(host.configure).toHaveBeenCalledWith(model);
    expect(host.createConversation).toHaveBeenCalledWith("conversation-1", "token");
  });

  it("refreshes the latest snapshot without requiring an idle session", async () => {
    const latest = { ...snapshot, eventRevision: 8 };
    const host = createHost({ getSnapshot: vi.fn(async () => latest) });
    const session = createSession(host);
    await session.open();
    await session.send("hello");

    await expect(session.refresh()).resolves.toBe(latest);
    expect(host.getSnapshot).toHaveBeenCalledWith("conversation-1", "token");
    expect(session.modelConfig).toBe(model);
  });

  it("clears the conversation and caches the returned snapshot", async () => {
    const cleared = { ...snapshot, eventRevision: 5 };
    const host = createHost({ clearConversation: vi.fn(async () => cleared) });
    const session = createSession(host);
    await session.open();

    await expect(session.clear()).resolves.toBe(cleared);
    expect(host.clearConversation).toHaveBeenCalledWith("conversation-1", "token");
  });

  it("delegates manual compaction and caches the returned snapshot", async () => {
    const compactedSnapshot = { ...snapshot, eventRevision: 3 };
    const host = createHost({
      compactConversation: vi.fn(async () => ({
        result: { status: "compacted" as const },
        snapshot: compactedSnapshot,
      })),
    });
    const session = createSession(host);
    await session.open();

    await expect(session.compact()).resolves.toEqual({
      result: { status: "compacted" },
      snapshot: compactedSnapshot,
    });
    expect(host.compactConversation).toHaveBeenCalledWith("conversation-1", "token", {});
  });

  it("passes one-shot summary instructions to the host", async () => {
    const host = createHost();
    const session = createSession(host);
    await session.open();

    await session.compact({ instructions: "保留数据库迁移决定" });

    expect(host.compactConversation).toHaveBeenCalledWith("conversation-1", "token", {
      instructions: "保留数据库迁移决定",
    });
  });

  it("rejects clearing while a run is active", async () => {
    const host = createHost();
    const session = createSession(host);
    await session.open();
    await session.send("hello");

    await expect(session.clear()).rejects.toThrowError("上一轮尚未结束。");
    expect(host.clearConversation).not.toHaveBeenCalled();
  });

  it("sends one text-only request and tracks the active run", async () => {
    const host = createHost();
    const session = createSession(host);
    await session.open();

    await expect(session.send("hello")).resolves.toBe("run-1");
    expect(host.send).toHaveBeenCalledWith(
      "conversation-1",
      { text: "hello", images: [] },
      "token",
    );
    expect(session.cancel()).toBe(true);
    expect(host.cancel).toHaveBeenCalledWith("run-1");
  });

  it("passes queued acceptance through the host and activates the started run", async () => {
    const queuedHost = createHost({
      enqueue: vi.fn(async () => ({ queueId: "queue-2", status: "queued" as const, position: 1 })),
      waitForQueueStart: vi.fn(async () => ({
        queueId: "queue-2",
        runId: "run-2",
        snapshot,
      })),
    });
    const session = createSession(queuedHost);
    await session.open();

    await expect(session.enqueue("next")).resolves.toEqual({
      queueId: "queue-2",
      status: "queued",
      position: 1,
    });
    expect(queuedHost.enqueue).toHaveBeenCalledWith(
      "conversation-1",
      { text: "next", images: [] },
      "token",
    );
    expect(session.cancel()).toBe(false);

    await expect(session.waitForQueueStart("queue-2")).resolves.toEqual({
      queueId: "queue-2",
      runId: "run-2",
      snapshot,
    });
    expect(session.cancel()).toBe(true);
    expect(queuedHost.cancel).toHaveBeenCalledWith("run-2");
  });

  it("sends image attachments with the prompt", async () => {
    const host = createHost();
    const session = createSession(host);
    await session.open();
    const image = { name: "capture.png", dataUrl: "data:image/png;base64,QUJD" };

    await expect(session.send("look", [image])).resolves.toBe("run-1");
    expect(host.send).toHaveBeenCalledWith(
      "conversation-1",
      { text: "look", images: [image] },
      "token",
    );
  });

  it("rejects a concurrent send before the first one resolves", async () => {
    let resolveSend: (value: { runId: string }) => void = () => {};
    const host = createHost({
      send: vi.fn(
        () =>
          new Promise<{ runId: string }>((resolve) => {
            resolveSend = resolve;
          }),
      ),
    });
    const session = createSession(host);
    await session.open();

    const first = session.send("first");
    await expect(session.send("second")).rejects.toThrowError("上一轮尚未结束。");
    resolveSend({ runId: "run-1" });
    await expect(first).resolves.toBe("run-1");
  });

  it("clears the active run after waiting, even when the wait fails", async () => {
    const host = createHost({
      waitForRun: vi.fn(async () => {
        throw new Error("model failed");
      }),
    });
    const session = createSession(host);
    await session.open();
    await session.send("hello");

    await expect(session.wait("run-1")).rejects.toThrowError("model failed");
    expect(session.cancel()).toBe(false);
    await expect(session.send("again")).resolves.toBe("run-1");
  });

  it("returns false when cancelling without an active run", async () => {
    const host = createHost();
    const session = createSession(host);

    expect(session.cancel()).toBe(false);
    expect(host.cancel).not.toHaveBeenCalled();
  });

  it("rejects sending before open and after close", async () => {
    const host = createHost();
    const session = createSession(host);

    await expect(session.send("before")).rejects.toThrowError("会话尚未打开。");
    await session.open();
    session.close();
    session.close();

    expect(host.dispose).not.toHaveBeenCalled();
    await expect(session.open()).rejects.toThrowError("会话已关闭。");
    await expect(session.send("after")).rejects.toThrowError("会话已关闭。");
  });

  it("reconfigures the host when the model changes while idle", async () => {
    const host = createHost();
    const session = createSession(host);
    await session.open();

    session.setModel(nextModel);

    expect(host.configure).toHaveBeenCalledWith(nextModel);
  });

  it("rejects switching models while a run is active", async () => {
    const host = createHost();
    const session = createSession(host);
    await session.open();
    await session.send("hello");

    expect(() => session.setModel(nextModel)).toThrowError("当前运行中，不能切换模型。");
    expect(host.configure).toHaveBeenCalledTimes(1);
  });

  it("rejects switching models after close", async () => {
    const session = createSession(createHost());
    session.close();

    expect(() => session.setModel(nextModel)).toThrowError("会话已关闭。");
  });

  it("starts a new conversation with an injected id", async () => {
    const nextSnapshot = { ...snapshot, conversationId: "conversation-2" };
    const host = createHost({
      createConversation: vi.fn(async (conversationId: string) => ({
        ...nextSnapshot,
        conversationId,
      })),
    });
    const session = new CodingSession({
      host,
      conversationId: "conversation-1",
      createConversationId: () => "conversation-2",
      model,
      accessToken: "token",
    });
    await session.open();

    await expect(session.startNewConversation()).resolves.toMatchObject({
      conversationId: "conversation-2",
    });
    expect(host.createConversation).toHaveBeenLastCalledWith("conversation-2", "token");
    expect(session.currentConversationId).toBe("conversation-2");
  });

  it("resumes a conversation and lists sessions", async () => {
    const resumed = { ...snapshot, conversationId: "conversation-old" };
    const summaries = [
      {
        conversationId: "conversation-old",
        scope: "coding" as const,
        title: "旧会话",
        messageCount: 2,
        createdAt: "2026-11-14T00:00:00.000Z",
        updatedAt: "2026-11-14T01:00:00.000Z",
      },
    ];
    const host = createHost({
      getSnapshot: vi.fn(async () => resumed),
      listSessions: vi.fn(async () => ({ items: summaries })),
    });
    const session = createSession(host);
    await session.open();

    await expect(session.resume("conversation-old")).resolves.toBe(resumed);
    expect(session.currentConversationId).toBe("conversation-old");
    await expect(session.listSessions()).resolves.toEqual({ items: summaries });
  });

  it("deletes the current conversation and starts a new one", async () => {
    const nextSnapshot = { ...snapshot, conversationId: "conversation-3" };
    const host = createHost({
      createConversation: vi.fn(async (conversationId: string) => ({
        ...nextSnapshot,
        conversationId,
      })),
    });
    const session = new CodingSession({
      host,
      conversationId: "conversation-1",
      createConversationId: () => "conversation-3",
      model,
      accessToken: "token",
    });
    await session.open();

    await expect(session.deleteSession("conversation-1")).resolves.toMatchObject({
      conversationId: "conversation-3",
    });
    expect(host.deleteSession).toHaveBeenCalledWith("conversation-1");
    expect(host.createConversation).toHaveBeenLastCalledWith("conversation-3", "token");
  });
});
