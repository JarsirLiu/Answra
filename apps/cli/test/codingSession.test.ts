import type { ConversationModelConfig, ConversationSnapshot } from "@answra/shared";
import { describe, expect, it, vi } from "vitest";
import { CodingSession, type CodingSessionHost } from "../src/session/codingSession";

const model: ConversationModelConfig = {
  chat: { baseUrl: "http://127.0.0.1:1234/v1", model: "chat", auth: "local" },
  answer: { baseUrl: "http://127.0.0.1:1234/v1", model: "answer", auth: "local" },
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
    clearConversation: vi.fn(async () => snapshot),
    send: vi.fn(async () => ({ runId: "run-1" })),
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
    expect(host.createConversation).toHaveBeenCalledWith("conversation-1");
  });

  it("clears the conversation and caches the returned snapshot", async () => {
    const cleared = { ...snapshot, eventRevision: 5 };
    const host = createHost({ clearConversation: vi.fn(async () => cleared) });
    const session = createSession(host);
    await session.open();

    await expect(session.clear()).resolves.toBe(cleared);
    expect(host.clearConversation).toHaveBeenCalledWith("conversation-1");
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

    expect(host.dispose).toHaveBeenCalledTimes(1);
    await expect(session.open()).rejects.toThrowError("会话已关闭。");
    await expect(session.send("after")).rejects.toThrowError("会话已关闭。");
  });
});
