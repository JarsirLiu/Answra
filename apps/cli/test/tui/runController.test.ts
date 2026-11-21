import type { ConversationModelConfig, ConversationSnapshot } from "@answra/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingSession } from "../../src/session/codingSession";
import { TuiViewStore } from "../../src/tui/app/viewStore";
import { TuiRunController } from "../../src/tui/runController";

const model: ConversationModelConfig = {
  chat: { baseUrl: "http://127.0.0.1:1234/v1", model: "test-model", auth: "local" },
  answer: { baseUrl: "http://127.0.0.1:1234/v1", model: "test-model", auth: "local" },
};

function snapshot(conversationId: string, revision = 0): ConversationSnapshot {
  return { conversationId, eventRevision: revision, messages: [] };
}

function createSession(conversationId: string) {
  let currentId = conversationId;
  const sent: string[] = [];
  const waits: Array<() => void> = [];
  const start = (text: string): string => {
    sent.push(text);
    return `run-${sent.length}`;
  };
  const session = {
    get currentConversationId() {
      return currentId;
    },
    modelConfig: model,
    open: vi.fn(async () => snapshot(currentId)),
    refresh: vi.fn(async () => snapshot(currentId)),
    send: vi.fn(async (text: string) => start(text)),
    enqueue: vi.fn(async (text: string) => {
      const runId = start(text);
      return {
        queueId: `queue-${runId}`,
        status: "started" as const,
        position: 0 as const,
        runId,
        snapshot: snapshot(currentId),
      };
    }),
    waitForQueueStart: vi.fn(),
    wait: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          waits.push(resolve);
        }),
    ),
    cancel: vi.fn(),
    cancelRun: vi.fn(),
    clear: vi.fn(async () => snapshot(currentId)),
    compact: vi.fn(async () => ({
      result: { status: "compacted" as const },
      snapshot: snapshot(currentId),
    })),
    startNewConversation: vi.fn(async () => {
      currentId = `${conversationId}-next`;
      return snapshot(currentId);
    }),
    deleteSession: vi.fn(async () => undefined),
    setModel: vi.fn(),
    setAccessToken: vi.fn(),
    close: vi.fn(),
  } as unknown as CodingSession;
  return { session, sent, waits };
}

function createController(
  session: CodingSession,
  store: TuiViewStore,
  factory?: (model: ConversationModelConfig, token?: string, id?: string) => CodingSession,
): TuiRunController {
  const controller = new TuiRunController({
    store,
    ...(factory === undefined ? {} : { createSession: factory }),
    resolveAccessToken: async () => "token",
  });
  controller.register(session);
  return controller;
}

describe("TuiRunController", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("switches back to a running session with its latest snapshot", async () => {
    const store = new TuiViewStore();
    const background = createSession("conversation-1");
    store.initialize(snapshot("conversation-1"));
    const controller = createController(
      background.session,
      store,
      (_model, _token, id) => createSession(id ?? "generated").session,
    );

    controller.submit("first");
    await Promise.resolve();
    await controller.activate("conversation-2");
    expect(store.getSnapshot()).toMatchObject({ phase: "idle" });

    vi.mocked(background.session.refresh).mockResolvedValue({
      ...snapshot("conversation-1", 7),
      activeRunId: "run-1",
    });
    await controller.activate("conversation-1");

    expect(background.session.refresh).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toMatchObject({ view: { eventRevision: 7 }, phase: "running" });
  });

  it("does not let a background completion change the foreground phase", async () => {
    const store = new TuiViewStore();
    const background = createSession("conversation-1");
    const foreground = createSession("conversation-2");
    store.initialize(snapshot("conversation-1"));
    const controller = createController(background.session, store, () => foreground.session);

    controller.submit("background");
    await Promise.resolve();
    await controller.activate("conversation-2");
    background.waits.shift()?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(store.getSnapshot()).toMatchObject({ phase: "idle", localError: undefined });
  });

  it("cancels only the active session", async () => {
    const store = new TuiViewStore();
    const background = createSession("conversation-1");
    const foreground = createSession("conversation-2");
    store.initialize(snapshot("conversation-1"));
    const controller = createController(background.session, store, () => foreground.session);

    controller.submit("background");
    await Promise.resolve();
    await controller.activate("conversation-2");
    controller.submit("foreground");
    await Promise.resolve();

    expect(controller.cancel()).toBe(true);
    expect(foreground.session.cancelRun).toHaveBeenCalledTimes(1);
    expect(background.session.cancelRun).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toMatchObject({ phase: "cancelling", queued: 0 });
  });

  it("rekeys the active runtime after creating a new conversation", async () => {
    const store = new TuiViewStore();
    const active = createSession("conversation-1");
    store.initialize(snapshot("conversation-1"));
    const controller = createController(active.session, store);

    await controller.createNew();
    expect(store.getSnapshot().view.eventRevision).toBe(0);
    expect(controller.activeSession?.currentConversationId).toBe("conversation-1-next");

    controller.submit("next");
    await Promise.resolve();
    expect(active.sent).toEqual(["next"]);
  });

  it("keeps a prompt visible while the host accepts it", async () => {
    const store = new TuiViewStore();
    const active = createSession("conversation-1");
    store.initialize(snapshot("conversation-1"));
    const controller = createController(active.session, store);
    let accept!: (runId: string) => void;
    vi.mocked(active.session.enqueue).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          accept = (runId) =>
            resolve({
              queueId: `queue-${runId}`,
              status: "started",
              position: 0,
              runId,
              snapshot: snapshot("conversation-1"),
            });
        }),
    );

    controller.submit("first");
    await Promise.resolve();
    expect(store.getSnapshot().queuedPrompts).toMatchObject([
      { text: "first", imageCount: 0, status: "sending" },
    ]);

    accept("run-1");
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getSnapshot().queuedPrompts).toEqual([]);

    active.waits.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
  });

  it("does not drop a prompt queued after cancellation clears an in-flight send", async () => {
    const store = new TuiViewStore();
    const active = createSession("conversation-1");
    store.initialize(snapshot("conversation-1"));
    const controller = createController(active.session, store);
    let accept!: (runId: string) => void;
    vi.mocked(active.session.enqueue).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          accept = (runId) =>
            resolve({
              queueId: `queue-${runId}`,
              status: "started",
              position: 0,
              runId,
              snapshot: snapshot("conversation-1"),
            });
        }),
    );

    controller.submit("first");
    await Promise.resolve();
    controller.cancel();
    controller.submit("second");
    expect(store.getSnapshot().queuedPrompts).toMatchObject([{ text: "second", status: "queued" }]);

    accept("run-1");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(active.sent).toEqual(["second"]);
    expect(store.getSnapshot().queuedPrompts).toEqual([]);

    active.waits.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getSnapshot().phase).toBe("idle");
  });

  it("keeps a host-queued prompt until the host starts it", async () => {
    const store = new TuiViewStore();
    const active = createSession("conversation-1");
    store.initialize(snapshot("conversation-1"));
    const controller = createController(active.session, store);
    vi.mocked(active.session.enqueue).mockResolvedValueOnce({
      queueId: "queue-1",
      status: "queued",
      position: 1,
    });
    let start!: (runId: string) => void;
    vi.mocked(active.session.waitForQueueStart).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          start = (runId) =>
            resolve({ queueId: "queue-1", runId, snapshot: snapshot("conversation-1") });
        }),
    );

    controller.submit("queued");
    await Promise.resolve();
    expect(store.getSnapshot().queuedPrompts).toMatchObject([
      { text: "queued", imageCount: 0, status: "queued" },
    ]);

    start("run-1");
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getSnapshot().queuedPrompts).toEqual([]);
    expect(active.waits).toHaveLength(1);

    active.waits.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getSnapshot().phase).toBe("idle");
  });

  it("refuses to delete a busy target and leaves idle runtimes closable", async () => {
    const store = new TuiViewStore();
    const active = createSession("conversation-1");
    const target = createSession("conversation-2");
    store.initialize(snapshot("conversation-1"));
    const controller = createController(active.session, store, () => target.session);

    await controller.activate("conversation-2");
    controller.submit("busy");
    await Promise.resolve();

    await expect(controller.delete("conversation-2")).rejects.toThrow("正在运行");
    target.waits.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    await controller.activate("conversation-1");
    await controller.delete("conversation-2");
    expect(target.session.close).toHaveBeenCalledTimes(1);
  });
});
