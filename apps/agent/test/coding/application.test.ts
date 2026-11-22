import { createServer, type Server } from "node:http";
import {
  CODING_AGENT_ID,
  type CodingHost,
  SessionFrameBus,
  startCodingHost,
} from "@answra/agent/composition";
import type { AgentEventEnvelope, LiveFrame, SessionFrame } from "@answra/shared/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodingAgentInput } from "../../src/coding/agent";
import { CodingApplication } from "../../src/coding/application";
import type { CodingBot } from "../../src/coding/bot";
import { CODING_POLICY } from "../../src/coding/policy";
import type { AgentExecutor } from "../../src/core/agent/definition";
import type { AgentRuntime } from "../../src/core/agent/runtime";
import { type StepRunner, sessionId, stepId, turnId } from "../../src/core/session/contracts";
import { MemorySessionJournal } from "../../src/core/session/memoryJournal";
import { MemoryConversationStore } from "../../src/core/transcript/memoryStore";
import { createUserMessage } from "../../src/core/transcript/message";
import { MemoryExecutionStore } from "../../src/execution/memoryStore";

type RecordedRequest = {
  messages: Array<{ role: string; content: unknown }>;
  tools?: unknown;
  authorization?: string;
};

const ACCESS_TOKEN = "coding-access-token";

function endpoint(port: number) {
  return { baseUrl: `http://127.0.0.1:${port}/v1`, model: "text.chat" };
}

function streamBody(text: string): string {
  return [
    `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "text.chat", choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "thinking", content: text }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "text.chat", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

function toolCallBody(name: string, input: unknown): string {
  return [
    `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "text.chat", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name, arguments: JSON.stringify(input) } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "text.chat", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

describe("CLI coding host", () => {
  let server: Server;
  let requests: RecordedRequest[];
  let events: AgentEventEnvelope[];
  let host: CodingHost;
  let holdResponse = false;
  let responseGate: Promise<void> | undefined;
  let respond: ((call: number) => string) | undefined;

  beforeEach(async () => {
    requests = [];
    events = [];
    holdResponse = false;
    responseGate = undefined;
    respond = undefined;
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        messages?: Array<{ role: string; content: unknown }>;
        tools?: unknown;
      };
      requests.push({
        messages: parsed.messages ?? [],
        tools: parsed.tools,
        authorization: request.headers.authorization,
      });
      if (holdResponse) return;
      if (responseGate) await responseGate;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(respond?.(requests.length) ?? streamBody("已读取"));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");

    host = startCodingHost({
      emitEvent: (event) => events.push(event),
      workspaceRoot: "D:/coding-workspace",
    });
    host.runtime.configure({ chat: endpoint(address.port), answer: endpoint(address.port) });
  });

  afterEach(async () => {
    host?.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("runs the dedicated coding bot with its own prompt, tools, and snapshot", async () => {
    const created = await host.runtime.createConversation("coding-session");
    expect(created.activeAgentId).toBe(CODING_AGENT_ID);
    expect(created.participantAgentIds).toEqual([CODING_AGENT_ID]);

    const { turnId, snapshot } = await host.runtime.send(
      "coding-session",
      { text: "读取 README 并概述结构", images: [] },
      ACCESS_TOKEN,
    );
    expect(snapshot.activeTurnId).toBe(turnId);
    // envelope 的 runId 仍是该 Turn 的首条 assistant 消息 id。
    const messageId = snapshot.messages.at(-1)?.id;
    expect(snapshot.activeMessageId).toBe(messageId);
    await host.runtime.waitForTurn("coding-session", turnId);

    const final = await host.runtime.getSnapshot("coding-session");
    expect(final.messages.map((message) => [message.role, message.text, message.status])).toEqual([
      ["user", "读取 README 并概述结构", "complete"],
      ["assistant", "已读取", "complete"],
    ]);
    expect(final.activeMessageId).toBeUndefined();

    const body = JSON.stringify(requests.at(-1));
    expect(body).toContain("命令行编码助手");
    expect(body).toContain("当前工作目录：D:/coding-workspace");
    expect(body).toContain("Read");
    expect(body).toContain("Grep");
    expect(body).toContain("Edit");
    expect(body).toContain("RunCommand");
    expect(body).not.toContain("WriteStdin");
    expect(body).not.toContain("通用 AI 助手");
    expect(requests.at(-1)?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(
      events.some((event) => event.runId === messageId && event.event.type === "text-delta"),
    ).toBe(true);
  });

  it("publishes durable and live frames through the coding host bus", async () => {
    const frames: SessionFrame[] = [];
    const live: LiveFrame[] = [];
    host.sessionFrames.subscribe({
      onFrame: (frame) => frames.push(frame),
      onLiveFrame: (frame) => live.push(frame),
    });

    await host.runtime.createConversation("coding-frames");
    const { turnId } = await host.runtime.send(
      "coding-frames",
      { text: "读取 README", images: [] },
      ACCESS_TOKEN,
    );
    await host.runtime.waitForTurn("coding-frames", turnId);

    expect(frames.map((frame) => frame.seq)).toEqual(frames.map((_, index) => index + 1));
    expect(frames[0]?.event.type).toBe("turn-queued");
    expect(frames.at(-1)?.event.type).toBe("turn-finished");
    expect(live.length).toBeGreaterThan(0);
  });

  it("uses the injected frame bus instead of creating a private one", () => {
    const bus = new SessionFrameBus();
    const injected = startCodingHost({ emitEvent: () => undefined, sessionFrames: bus });
    try {
      expect(injected.sessionFrames).toBe(bus);
    } finally {
      injected.dispose();
    }
  });

  it("accepts image input and forwards it to the model", async () => {
    await host.runtime.createConversation("coding-images");
    const image = { name: "capture.png", dataUrl: "data:image/png;base64,QUJD" };

    const { turnId } = await host.runtime.send(
      "coding-images",
      { text: "看这张图", images: [image] },
      ACCESS_TOKEN,
    );
    await host.runtime.waitForTurn("coding-images", turnId);

    const snapshot = await host.runtime.getSnapshot("coding-images");
    expect(snapshot.messages[0]?.images).toEqual([image]);
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("data:image/png;base64,QUJD");
  });

  it("accepts an image-only message", async () => {
    await host.runtime.createConversation("coding-image-only");

    const { turnId } = await host.runtime.send(
      "coding-image-only",
      { text: "", images: [{ name: "capture.png", dataUrl: "data:image/png;base64,QUJD" }] },
      ACCESS_TOKEN,
    );
    await host.runtime.waitForTurn("coding-image-only", turnId);

    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("data:image/png;base64,QUJD");
  });

  it("keeps image attachments in later transcript context", async () => {
    await host.runtime.createConversation("coding-image-history");
    const dataUrl = "data:image/png;base64,QUJD";
    const first = await host.runtime.send(
      "coding-image-history",
      { text: "看这张图", images: [{ name: "capture.png", dataUrl }] },
      ACCESS_TOKEN,
    );
    await host.runtime.waitForTurn("coding-image-history", first.turnId);
    const second = await host.runtime.send(
      "coding-image-history",
      { text: "继续", images: [] },
      ACCESS_TOKEN,
    );
    await host.runtime.waitForTurn("coding-image-history", second.turnId);

    expect(JSON.stringify(requests.at(-1)?.messages)).toContain(dataUrl);
  });

  it("starts a queued turn only after the active turn finishes", async () => {
    respond = (call) =>
      call === 1
        ? toolCallBody("Read", { file_path: "D:/coding-workspace/missing.txt" })
        : streamBody(call === 2 ? "continued" : "second answer");
    await host.runtime.createConversation("coding-turn-queue");

    const first = await host.runtime.enqueue(
      "coding-turn-queue",
      { text: "first", images: [] },
      ACCESS_TOKEN,
    );
    if (first.status !== "started") throw new Error("first message did not start");
    const second = await host.runtime.enqueue(
      "coding-turn-queue",
      { text: "second requirement", images: [] },
      ACCESS_TOKEN,
    );
    expect(second).toMatchObject({ status: "queued", position: 1 });

    const started = await host.runtime.waitForQueueStart("coding-turn-queue", second.queueId);
    await host.runtime.waitForTurn("coding-turn-queue", started.turnId);
    await host.runtime.waitForTurn("coding-turn-queue", first.turnId);

    const firstMessageId = first.snapshot.activeMessageId;
    expect(firstMessageId).toBeDefined();
    const order = events.map((event) => event);
    const firstCompleted = order.findIndex(
      (event) =>
        event.runId === firstMessageId &&
        event.event.type === "run-state-changed" &&
        event.event.state === "completed",
    );
    const secondStarted = order.findIndex(
      (event) => event.runId === started.snapshot.activeMessageId,
    );
    expect(firstCompleted).toBeGreaterThanOrEqual(0);
    expect(secondStarted).toBeGreaterThan(firstCompleted);

    // 第一 turn 的 tool 调用后继续同一 Turn，不把队列消息插进 step 之间。
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("second requirement");
    const final = await host.runtime.getSnapshot("coding-turn-queue");
    expect(final.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("cancels an active coding run and the queued turns behind it", async () => {
    holdResponse = true;
    await host.runtime.createConversation("coding-cancel");
    const { turnId, snapshot } = await host.runtime.send(
      "coding-cancel",
      { text: "运行一个长任务", images: [] },
      ACCESS_TOKEN,
    );
    const messageId = snapshot.activeMessageId;
    expect(messageId).toBeDefined();
    const queued = await host.runtime.enqueue(
      "coding-cancel",
      { text: "排队任务", images: [] },
      ACCESS_TOKEN,
    );
    if (queued.status !== "queued") throw new Error("second message should be queued");

    host.runtime.cancel("coding-cancel", turnId);

    await expect
      .poll(
        () =>
          events.some(
            (event) =>
              event.runId === messageId &&
              event.event.type === "run-state-changed" &&
              event.event.state === "aborted",
          ),
        { timeout: 5_000, interval: 10 },
      )
      .toBe(true);
    await host.runtime.waitForTurn("coding-cancel", turnId);
    await expect(host.runtime.waitForQueue("coding-cancel", queued.queueId)).resolves.toMatchObject(
      { outcome: "aborted" },
    );

    const final = await host.runtime.getSnapshot("coding-cancel");
    expect(final.messages.map((message) => [message.role, message.status])).toEqual([
      ["user", "complete"],
      ["assistant", "interrupted"],
    ]);
  });

  it("does not start queued turns while shutting down", async () => {
    holdResponse = true;
    await host.runtime.createConversation("coding-shutdown");
    const first = await host.runtime.enqueue(
      "coding-shutdown",
      { text: "first", images: [] },
      ACCESS_TOKEN,
    );
    expect(first.status).toBe("started");
    await expect.poll(() => requests.length, { timeout: 5_000, interval: 10 }).toBe(1);
    const second = await host.runtime.enqueue(
      "coding-shutdown",
      { text: "second", images: [] },
      ACCESS_TOKEN,
    );
    expect(second).toMatchObject({ status: "queued", position: 1 });

    await host.shutdown();

    expect(requests).toHaveLength(1);
    await expect(
      host.runtime.waitForQueue("coding-shutdown", second.queueId),
    ).resolves.toMatchObject({ outcome: "aborted" });
  });
});

function codingSeed() {
  return {
    activeAgentId: CODING_AGENT_ID,
    participantAgentIds: [CODING_AGENT_ID],
    bots: [{ id: CODING_AGENT_ID, name: "Coding 助手", role: "engineer" }],
  };
}

function fakeRuntime(): AgentRuntime {
  return {
    cancel: vi.fn(),
    dispose: vi.fn(),
    resetExecution: vi.fn(async () => undefined),
    chatContextWindow: () => undefined,
    chatEndpoint: () => ({ baseUrl: "http://127.0.0.1:1/v1", model: "test" }),
    configureModelRoutes: vi.fn(),
    generateText: vi.fn(async () => "summary"),
    modelTokenProvider: () => async () => "token",
  } as unknown as AgentRuntime;
}

function makeBot(): CodingBot {
  const executor: AgentExecutor<CodingAgentInput> = {
    startRun: async () => {
      throw new Error("Session 底座不应调用 startRun");
    },
    prepare: async () => ({ system: "", messages: [] }),
  };
  return {
    id: CODING_AGENT_ID,
    identity: {
      name: "Coding 助手",
      role: "engineer",
      responsibility: "测试 coding 会话。",
      owns: ["coding"],
    },
    discovery: { visibleTo: { kind: "bots", agentIds: [] } },
    domain: "coding",
    executor,
    policy: CODING_POLICY,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function makeApp({
  store,
  journal,
  events,
  runner,
}: {
  store: MemoryConversationStore;
  journal: MemorySessionJournal;
  events: MemoryExecutionStore;
  runner: StepRunner;
}): CodingApplication {
  return new CodingApplication({
    agentRuntime: fakeRuntime(),
    store,
    bot: makeBot(),
    sessionJournal: journal,
    executionStore: events,
    stepRunner: runner,
    onSnapshot: () => undefined,
  });
}

describe("CodingApplication queue and recovery", () => {
  it("runs queued turns in order after the active turn finishes", async () => {
    const store = new MemoryConversationStore();
    const journal = new MemorySessionJournal();
    const events = new MemoryExecutionStore();
    const gate = deferred();
    const stepMessages: string[] = [];
    const runner: StepRunner = {
      async run(step) {
        stepMessages.push(step.messageId);
        await gate.promise;
        return { outcome: "completed", finishReason: "stop" };
      },
    };
    const app = makeApp({ store, journal, events, runner });
    await app.createConversation("coding-queue");

    const first = await app.enqueue("coding-queue", { text: "first", images: [] }, "token");
    if (first.status !== "started") throw new Error("first message did not start");
    const second = await app.enqueue("coding-queue", { text: "second", images: [] }, "token");
    expect(second).toMatchObject({ status: "queued", position: 1 });

    gate.resolve();
    const started = await app.waitForQueueStart("coding-queue", second.queueId);
    await app.waitForTurn("coding-queue", started.turnId);
    await app.waitForTurn("coding-queue", first.turnId);

    expect(stepMessages).toEqual([
      first.snapshot.activeMessageId,
      started.snapshot.activeMessageId,
    ]);
    const snapshot = await app.getSnapshot("coding-queue");
    expect(snapshot.messages.map((message) => [message.role, message.status])).toEqual([
      ["user", "complete"],
      ["assistant", "complete"],
      ["user", "complete"],
      ["assistant", "complete"],
    ]);
  });

  it("records manual compaction lifecycle in the session journal", async () => {
    const store = new MemoryConversationStore();
    const journal = new MemorySessionJournal();
    const events = new MemoryExecutionStore();
    const runner: StepRunner = {
      async run() {
        return { outcome: "completed", finishReason: "stop" };
      },
    };
    const app = makeApp({ store, journal, events, runner });
    await app.createConversation("coding-compact");
    const { turnId } = await app.send("coding-compact", { text: "旧问题", images: [] }, "token");
    await app.waitForTurn("coding-compact", turnId);

    const { result } = await app.compactConversation("coding-compact", "token");
    expect(result.status).toBe("compacted");

    const rows = await journal.readAfter(sessionId("coding-compact"), 0);
    const compaction = rows.filter((row) => row.event.type.startsWith("compaction-"));
    expect(compaction.map((row) => row.event.type)).toEqual([
      "compaction-started",
      "compaction-finished",
    ]);
    expect(compaction[0]?.operationId).toBeDefined();
    expect(compaction[1]?.operationId).toBe(compaction[0]?.operationId);
    expect(compaction[0]?.event).toMatchObject({ trigger: "manual", reason: "manual" });
  });

  it("cancels queued turns when the active run is cancelled", async () => {
    const store = new MemoryConversationStore();
    const journal = new MemorySessionJournal();
    const events = new MemoryExecutionStore();
    const runner: StepRunner = {
      run: (_step, _context, signal) =>
        new Promise((resolve) => {
          if (signal.aborted) {
            resolve({ outcome: "aborted" });
            return;
          }
          signal.addEventListener("abort", () => resolve({ outcome: "aborted" }), { once: true });
        }),
    };
    const app = makeApp({ store, journal, events, runner });
    await app.createConversation("coding-stop");

    const first = await app.enqueue("coding-stop", { text: "first", images: [] }, "token");
    if (first.status !== "started") throw new Error("first message did not start");
    const second = await app.enqueue("coding-stop", { text: "second", images: [] }, "token");
    if (second.status !== "queued") throw new Error("second message should be queued");

    app.cancel("coding-stop", first.turnId);
    await app.waitForTurn("coding-stop", first.turnId);
    await expect(app.waitForQueue("coding-stop", second.queueId)).resolves.toMatchObject({
      outcome: "aborted",
    });

    const snapshot = await app.getSnapshot("coding-stop");
    expect(snapshot.messages.map((message) => [message.role, message.status])).toEqual([
      ["user", "complete"],
      ["assistant", "interrupted"],
    ]);
  });

  it("closes the interrupted message on startup recovery and accepts the next turn", async () => {
    const store = new MemoryConversationStore();
    const journal = new MemorySessionJournal();
    const events = new MemoryExecutionStore();
    const conversationId = "coding-recovery";
    const id = sessionId(conversationId);
    const turn = turnId("turn-1");
    const message = "assistant-1";
    await store.create(conversationId, codingSeed(), { scope: "coding" });
    await store.beginSessionTurn(conversationId, {
      turnId: turn,
      messageId: message,
      authorAgentId: CODING_AGENT_ID,
      userMessage: createUserMessage("user-1", { text: "旧问题", images: [] }),
    });
    await journal.append(
      id,
      {
        type: "turn-queued",
        source: "user",
        agentId: CODING_AGENT_ID,
        input: createUserMessage("user-1", { text: "旧问题", images: [] }),
      },
      { turnId: turn },
    );
    await journal.append(
      id,
      { type: "turn-started", agentId: CODING_AGENT_ID },
      { turnId: turn, messageId: message },
    );
    await journal.append(
      id,
      { type: "step-started", stepId: "step-1", index: 0, agentId: CODING_AGENT_ID },
      { turnId: turn, stepId: stepId("step-1"), messageId: message },
    );

    const runner: StepRunner = {
      async run() {
        return { outcome: "completed", finishReason: "stop" };
      },
    };
    const app = makeApp({ store, journal, events, runner });

    const recovered = await app.getSnapshot(conversationId);
    expect(recovered.activeMessageId).toBeUndefined();
    expect(recovered.messages.map((item) => [item.role, item.status])).toEqual([
      ["user", "complete"],
      ["assistant", "interrupted"],
    ]);

    const next = await app.send(conversationId, { text: "继续", images: [] }, "token");
    await app.waitForTurn(conversationId, next.turnId);
    const final = await app.getSnapshot(conversationId);
    expect(final.messages.map((item) => [item.role, item.status])).toEqual([
      ["user", "complete"],
      ["assistant", "interrupted"],
      ["user", "complete"],
      ["assistant", "complete"],
    ]);
  });

  it("resumes a queued turn from a previous process only when a token is supplied", async () => {
    const store = new MemoryConversationStore();
    const journal = new MemorySessionJournal();
    const events = new MemoryExecutionStore();
    const conversationId = "coding-queued-recovery";
    const id = sessionId(conversationId);
    const turn = turnId("turn-1");
    await store.create(conversationId, codingSeed(), { scope: "coding" });
    await journal.append(
      id,
      {
        type: "turn-queued",
        source: "user",
        agentId: CODING_AGENT_ID,
        input: createUserMessage("user-1", { text: "排队问题", images: [] }),
      },
      { turnId: turn },
    );

    const runner: StepRunner = {
      async run() {
        return { outcome: "completed", finishReason: "stop" };
      },
    };
    const app = makeApp({ store, journal, events, runner });

    // 没有令牌就恢复会把排队消息烧成一条失败回复，因此必须先拒绝。
    await expect(app.getSnapshot(conversationId)).rejects.toThrow("排队消息需要访问令牌才能继续");

    const recovered = await app.getSnapshot(conversationId, "token");
    await app.waitForQueue(conversationId, "turn-1");
    const snapshot = await app.getSnapshot(conversationId);
    expect(recovered.messages.map((item) => [item.role, item.status])).toEqual([
      ["user", "complete"],
      ["assistant", "streaming"],
    ]);
    expect(snapshot.messages.map((item) => [item.role, item.status])).toEqual([
      ["user", "complete"],
      ["assistant", "complete"],
    ]);
    expect(snapshot.activeMessageId).toBeUndefined();
  });
});
