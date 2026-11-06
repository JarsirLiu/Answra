import { createServer, type Server } from "node:http";
import {
  ActiveChatConversationId,
  ActiveExamConversationId,
  type ConversationChange,
} from "@answra/shared";
import type { AgentEventEnvelope } from "@answra/shared/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryConversationStore } from "../../../src/conversation/session/memoryStore";
import type { ConversationStore } from "../../../src/conversation/session/store";
import { createAuthorizedConversationTools } from "../../../src/conversation/tools/registry";
import { ChatConversationRuntime } from "../../../src/conversation/turn/chatRuntime";

type RecordedRequest = {
  messages: Array<{ role: string; content: unknown }>;
  tools?: unknown;
  temperature?: number;
  reasoningEffort?: string;
  authorization?: string;
};

const ACCESS_TOKEN = "test-access-token";

function endpoint(port: number) {
  return { baseUrl: `http://127.0.0.1:${port}/v1`, model: "text.chat" };
}

function streamBody(text: string): string {
  return [
    `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "text.chat", choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "分析中", content: text }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "text.chat", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

describe("ephemeral conversation runtime", () => {
  let server: Server;
  let requests: RecordedRequest[];
  let runtime: ChatConversationRuntime;
  let changes: ConversationChange[];
  let executionEvents: AgentEventEnvelope[];
  let holdResponse: boolean;
  let modelFailure: { status: number; message: string } | undefined;
  let serverPort = 0;

  beforeEach(async () => {
    requests = [];
    changes = [];
    executionEvents = [];
    holdResponse = false;
    modelFailure = undefined;
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        messages?: Array<{ role: string; content: unknown }>;
        tools?: unknown;
        temperature?: number;
        reasoning_effort?: string;
      };
      requests.push({
        messages: parsed.messages ?? [],
        tools: parsed.tools,
        temperature: parsed.temperature,
        reasoningEffort: parsed.reasoning_effort,
        authorization: request.headers.authorization,
      });
      if (holdResponse) return;
      if (modelFailure) {
        response.writeHead(modelFailure.status, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: modelFailure.message } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(streamBody("收到"));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    serverPort = address.port;
    runtime = new ChatConversationRuntime({
      emit: (change) => changes.push(change),
      emitExecution: (event) => executionEvents.push(event),
      createTools: createAuthorizedConversationTools,
    });
    runtime.configure({ chat: endpoint(address.port), answer: endpoint(address.port) });
  });

  afterEach(async () => {
    runtime?.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("keeps every send independent and transmits the image as part of only that request", async () => {
    const first = await runtime.runAnswer(
      "test-conversation",
      {
        text: "解释截图 A",
        images: [{ name: "capture.png", dataUrl: "data:image/png;base64,QUJD" }],
      },
      ACCESS_TOKEN,
    );
    await waitForTerminal(first.runId);
    const second = await runtime.runAnswer(
      "test-conversation",
      { text: "只看问题 B", images: [] },
      ACCESS_TOKEN,
    );
    await waitForTerminal(second.runId);

    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[0]?.messages)).toContain("解释截图 A");
    expect(JSON.stringify(requests[0]?.messages)).toContain("image_url");
    expect(JSON.stringify(requests[1]?.messages)).toContain("只看问题 B");
    expect(JSON.stringify(requests[1]?.messages)).not.toContain("解释截图 A");
    expect(runtime.activeRunCount).toBe(0);
    const events = changes.flatMap((change) => (change.type === "event" ? [change.event] : []));
    const revisions = changes.map((change) =>
      change.type === "event"
        ? change.event.revision
        : change.type === "snapshot"
          ? change.snapshot.revision
          : change.revision,
    );
    expect(revisions).toEqual([...revisions].sort((left, right) => left - right));
    const snapshot = await runtime.getSnapshot("test-conversation");
    expect(snapshot.messages).toEqual([]);
    expect(snapshot.revision).toBeGreaterThan(0);
    expect(await runtime.readEventsAfter("test-conversation", 0)).toEqual([
      { type: "snapshot", snapshot },
    ]);
    expect(changes.filter((change) => change.type === "run-finished")).toHaveLength(2);
    expect(
      executionEvents
        .filter((event) => event.runId === first.runId)
        .map((event) => event.event.type === "run-state-changed" && event.event.state),
    ).toEqual(["queued", "claimed", "running", "completed"]);
    expect(
      events.some(
        (event) => event.stream.type === "reasoning-delta" && event.stream.delta === "分析中",
      ),
    ).toBe(true);
    expect(
      events.some((event) => event.stream.type === "text-delta" && event.stream.delta === "收到"),
    ).toBe(true);
  });

  it("replies to the last user message and resolves waitForRun after the run settles", async () => {
    await runtime.createConversation("reply-conversation");
    await runtime.appendUserMessage("reply-conversation", "请自我介绍");

    const { runId } = await runtime.replyToLastUser(
      "general-chat",
      "reply-conversation",
      async () => ACCESS_TOKEN,
    );
    await runtime.waitForRun(runId);

    const snapshot = await runtime.getSnapshot("reply-conversation");
    expect(
      snapshot.messages.map((message) => [message.role, message.text, message.status]),
    ).toEqual([
      ["user", "请自我介绍", "complete"],
      ["assistant", "收到", "complete"],
    ]);
    expect(snapshot.activeRunId).toBeUndefined();
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("请自我介绍");
  });

  it("surfaces a reply token failure through the claimed run instead of rejecting the start", async () => {
    await runtime.createConversation("reply-token-conversation");
    await runtime.appendUserMessage("reply-token-conversation", "请自我介绍");
    const getAccessToken = vi.fn(async () => {
      throw new Error("令牌不可用");
    });

    const { runId } = await runtime.replyToLastUser(
      "general-chat",
      "reply-token-conversation",
      getAccessToken,
    );
    await runtime.waitForRun(runId);

    expect(getAccessToken).toHaveBeenCalledTimes(1);
    const snapshot = await runtime.getSnapshot("reply-token-conversation");
    expect(
      snapshot.messages.map((message) => [message.role, message.text, message.status]),
    ).toEqual([
      ["user", "请自我介绍", "complete"],
      ["assistant", "", "failed"],
    ]);
    const runEvents = changes
      .flatMap((change) => (change.type === "event" ? [change.event] : []))
      .filter((event) => event.runId === runId);
    expect(runEvents.map((event) => event.stream.type)).toEqual(["start", "error"]);
    expect(runEvents[1]?.stream).toMatchObject({ type: "error", errorText: "令牌不可用" });
    expect(
      changes.some(
        (change) =>
          change.type === "run-finished" && change.runId === runId && change.outcome === "failed",
      ),
    ).toBe(true);
    expect(runtime.activeRunCount).toBe(0);
  });

  it("does not request a token when there is no user message to reply to", async () => {
    await runtime.createConversation("empty-conversation");
    const getAccessToken = vi.fn(async () => ACCESS_TOKEN);

    await expect(
      runtime.replyToLastUser("general-chat", "empty-conversation", getAccessToken),
    ).rejects.toThrow("没有可回复的用户消息");
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it("sets answer temperature and low reasoning effort without changing general chat", async () => {
    const answer = await runtime.runAnswer(
      "answer-tuning-conversation",
      { text: "这道题选什么", images: [] },
      ACCESS_TOKEN,
    );
    await waitForTerminal(answer.runId);
    expect(requests.at(-1)).toMatchObject({ temperature: 0.3, reasoningEffort: "low" });

    const chat = await runtime.sendChat(
      "general-chat",
      "chat-tuning-conversation",
      { text: "普通聊天", images: [] },
      ACCESS_TOKEN,
    );
    await waitForTerminal(chat.runId);
    expect(requests.at(-1)?.temperature).toBeUndefined();
    expect(requests.at(-1)?.reasoningEffort).toBeUndefined();
  });

  it("keeps a failed ephemeral round until the next round claims the conversation", async () => {
    modelFailure = {
      status: 403,
      message:
        "No model service is configured for this plan yet. Please contact the administrator.",
    };
    const failed = await runtime.runAnswer(
      "failed-conversation",
      { text: "这道题选什么", images: [] },
      ACCESS_TOKEN,
    );
    await waitForTerminal(failed.runId);

    const snapshot = await runtime.getSnapshot("failed-conversation");
    expect(snapshot.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(snapshot.messages[0]?.text).toBe("这道题选什么");
    const events = changes.flatMap((change) => (change.type === "event" ? [change.event] : []));
    expect(
      events.some(
        (event) =>
          event.stream.type === "error" && event.stream.errorText.includes("No model service"),
      ),
    ).toBe(true);

    modelFailure = undefined;
    const recovered = await runtime.runAnswer(
      "failed-conversation",
      { text: "第二题", images: [] },
      ACCESS_TOKEN,
    );
    await waitForTerminal(recovered.runId);
    expect((await runtime.getSnapshot("failed-conversation")).messages).toEqual([]);
  });

  it("sends chat history only in the independent general chat conversation", async () => {
    const first = await runtime.sendChat(
      "general-chat",
      ActiveChatConversationId,
      {
        text: "我叫小明",
        images: [],
      },
      ACCESS_TOKEN,
    );
    await waitForTerminal(first.runId);
    const second = await runtime.sendChat(
      "general-chat",
      ActiveChatConversationId,
      {
        text: "我叫什么？",
        images: [],
      },
      ACCESS_TOKEN,
    );
    await waitForTerminal(second.runId);

    const chatPayload = JSON.stringify(requests[1]?.messages);
    expect(chatPayload).toContain("我叫小明");
    expect(chatPayload).toContain("收到");
    expect(chatPayload).toContain("我叫什么？");

    const answer = await runtime.runAnswer(
      ActiveExamConversationId,
      {
        text: "只回答当前截图问题",
        images: [],
      },
      ACCESS_TOKEN,
    );
    await waitForTerminal(answer.runId);

    const answerPayload = JSON.stringify(requests[2]?.messages);
    expect(answerPayload).toContain("只回答当前截图问题");
    expect(answerPayload).not.toContain("我叫小明");
  });

  it("sends only profile-authorized Read and Grep schemas to the model", async () => {
    const chat = await runtime.sendChat(
      "general-chat",
      "tools-authorized-chat",
      { text: "读取工作区", images: [] },
      ACCESS_TOKEN,
    );
    await waitForTerminal(chat.runId);
    const chatTools = JSON.stringify(requests.at(-1)?.tools);
    expect(chatTools).toContain("Read");
    expect(chatTools).toContain("Grep");
    expect(chatTools).toContain("file_path");
    expect(chatTools).toContain("pattern");
    expect(chatTools).not.toContain("list_workspace_files");

    const answer = await runtime.runAnswer(
      "tools-unauthorized-answer",
      { text: "只回答当前截图问题", images: [] },
      ACCESS_TOKEN,
    );
    await waitForTerminal(answer.runId);
    expect(requests.at(-1)?.tools).toBeUndefined();
  });

  it("injects current date as a user-side system-reminder only for chat profiles", async () => {
    const { runId } = await runtime.sendChat(
      "general-chat",
      "time-inject-chat",
      {
        text: "今天几号？",
        images: [],
      },
      ACCESS_TOKEN,
    );
    await waitForTerminal(runId);

    const chatBody = JSON.stringify(requests.at(-1));
    expect(chatBody).toContain("<system-reminder>");
    expect(chatBody).toContain("currentDate");
    expect(chatBody).toContain("Current date and time is");

    const answer = await runtime.runAnswer(
      "time-inject-exam",
      {
        text: "答题",
        images: [],
      },
      ACCESS_TOKEN,
    );
    await waitForTerminal(answer.runId);
    const answerBody = JSON.stringify(requests.at(-1));
    expect(answerBody).not.toContain("currentDate");
  });

  it("rejects unregistered chat profiles", async () => {
    await expect(
      runtime.sendChat(
        "future-tool-chat" as "general-chat",
        "other-chat",
        {
          text: "hello",
          images: [],
        },
        ACCESS_TOKEN,
      ),
    ).rejects.toThrow("未授权");
    expect(runtime.activeRunCount).toBe(0);
  });

  it("rejects unsupported or oversized images without starting a run", async () => {
    await expect(
      runtime.runAnswer(
        "test-conversation",
        {
          text: "",
          images: [{ name: "bad.svg", dataUrl: "data:image/svg+xml;base64,QUJD" }],
        },
        ACCESS_TOKEN,
      ),
    ).rejects.toThrow("图片格式");
    await expect(
      runtime.runAnswer(
        "test-conversation",
        {
          text: "",
          images: [{ name: "bad.png", dataUrl: `data:image/png;base64,${"A".repeat(11_200_000)}` }],
        },
        ACCESS_TOKEN,
      ),
    ).rejects.toThrow("8 MB");
    expect(runtime.activeRunCount).toBe(0);
    expect(changes.filter((change) => change.type === "event")).toHaveLength(0);
  });

  it("aborts an active request and releases its temporary run state", async () => {
    holdResponse = true;
    const { runId } = await runtime.runAnswer(
      "test-conversation",
      { text: "请取消", images: [] },
      ACCESS_TOKEN,
    );
    runtime.cancel(runId);
    await waitForTerminal(runId);

    expect(
      changes.some(
        (change) =>
          change.type === "run-finished" && change.runId === runId && change.outcome === "aborted",
      ),
    ).toBe(true);
    expect(runtime.activeRunCount).toBe(0);
  });

  it("reports a 401 as the unified auth-required code so the renderer prompts login", async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    server = createServer((_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: "invalid api key", type: "authentication_error", code: "unauthorized" },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    runtime.configure({ chat: endpoint(address.port), answer: endpoint(address.port) });

    const { runId } = await runtime.runAnswer(
      "test-conversation",
      { text: "hello", images: [] },
      ACCESS_TOKEN,
    );
    await waitForTerminal(runId);

    const events = changes.flatMap((change) => (change.type === "event" ? [change.event] : []));
    const errorChunk = events.find(
      (event) => event.runId === runId && event.stream.type === "error",
    );
    expect(
      errorChunk && errorChunk.stream.type === "error" ? errorChunk.stream.errorText : "",
    ).toContain("auth-required");
    expect(
      changes.some(
        (change) =>
          change.type === "run-finished" && change.runId === runId && change.outcome === "failed",
      ),
    ).toBe(true);
    expect(runtime.activeRunCount).toBe(0);
  });

  it("replays the request once with a refreshed token and never loops", async () => {
    const authorizations: Array<string | undefined> = [];
    const forceRefreshFlags: boolean[] = [];
    let attempt = 0;
    const retryServer = createServer((request, response) => {
      authorizations.push(request.headers.authorization);
      attempt += 1;
      if (attempt === 1) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { message: "expired", type: "authentication_error", code: "unauthorized" },
          }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(streamBody("重试成功"));
    });
    await new Promise<void>((resolve) => retryServer.listen(0, "127.0.0.1", resolve));
    const address = retryServer.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");

    const retrying = new ChatConversationRuntime({
      emit: (change) => changes.push(change),
      createTools: createAuthorizedConversationTools,
      tokenProvider: async (options) => {
        forceRefreshFlags.push(options.forceRefresh);
        return "refreshed-token";
      },
    });
    try {
      retrying.configure({ chat: endpoint(address.port), answer: endpoint(address.port) });
      const { runId } = await retrying.runAnswer(
        "retry-conversation",
        { text: "hello", images: [] },
        "stale-token",
      );
      await waitForTerminal(runId);

      expect(authorizations).toEqual(["Bearer stale-token", "Bearer refreshed-token"]);
      expect(forceRefreshFlags).toEqual([true]);
      const events = changes.flatMap((change) => (change.type === "event" ? [change.event] : []));
      expect(
        events.some(
          (event) => event.stream.type === "text-delta" && event.stream.delta === "重试成功",
        ),
      ).toBe(true);
      expect(events.some((event) => event.runId === runId && event.stream.type === "error")).toBe(
        false,
      );
    } finally {
      retrying.dispose();
      await new Promise<void>((resolve) => retryServer.close(() => resolve()));
    }
  });

  it("stops after one retry when the endpoint keeps answering 401", async () => {
    const attempts: Array<string | undefined> = [];
    const unauthorizedServer = createServer((request, response) => {
      attempts.push(request.headers.authorization);
      response.writeHead(401, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: "unauthorized", type: "authentication_error", code: "unauthorized" },
        }),
      );
    });
    await new Promise<void>((resolve) => unauthorizedServer.listen(0, "127.0.0.1", resolve));
    const address = unauthorizedServer.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");

    const retrying = new ChatConversationRuntime({
      emit: (change) => changes.push(change),
      createTools: createAuthorizedConversationTools,
      tokenProvider: async () => "refreshed-token",
    });
    try {
      retrying.configure({ chat: endpoint(address.port), answer: endpoint(address.port) });
      const { runId } = await retrying.runAnswer(
        "retry-conversation",
        { text: "hello", images: [] },
        "stale-token",
      );
      await waitForTerminal(runId);

      expect(attempts).toEqual(["Bearer stale-token", "Bearer refreshed-token"]);
      const events = changes.flatMap((change) => (change.type === "event" ? [change.event] : []));
      expect(
        events.some(
          (event) =>
            event.runId === runId &&
            event.stream.type === "error" &&
            event.stream.errorText.includes("auth-required"),
        ),
      ).toBe(true);
      expect(retrying.activeRunCount).toBe(0);
    } finally {
      retrying.dispose();
      await new Promise<void>((resolve) => unauthorizedServer.close(() => resolve()));
    }
  });

  it("rejects the second of two concurrent answer runs and keeps the survivor intact", async () => {
    const settled = await Promise.allSettled([
      runtime.runAnswer("race-conversation", { text: "并发第一题", images: [] }, ACCESS_TOKEN),
      runtime.runAnswer("race-conversation", { text: "并发第二题", images: [] }, ACCESS_TOKEN),
    ]);
    const fulfilled = settled.filter(
      (outcome): outcome is PromiseFulfilledResult<{ runId: string }> =>
        outcome.status === "fulfilled",
    );
    const rejected = settled.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );

    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(Error);
    expect(rejected[0]?.reason.message).toBe("当前回复尚未完成");
    expect(fulfilled).toHaveLength(1);

    const survivorRunId = fulfilled[0]?.value.runId ?? "";
    await waitForTerminal(survivorRunId);
    const survivorEvents = changes
      .flatMap((change) => (change.type === "event" ? [change.event] : []))
      .filter((event) => event.runId === survivorRunId);
    expect(survivorEvents.some((event) => event.stream.type === "error")).toBe(false);
    expect(
      changes.some((change) => change.type === "run-finished" && change.runId === survivorRunId),
    ).toBe(true);
    expect(runtime.activeRunCount).toBe(0);
  });

  it("keeps the single-active-run invariant when every store await spans real time", async () => {
    // SQLite 形态回归：每个端口方法真实挂起一个宏任务。旧实现（load 检查 → clear →
    // beginRun 跨多个 await）在该形态下会破坏在途 run；原子认领必须保持不变量。
    const inner = new MemoryConversationStore();
    const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
    const store: ConversationStore = {
      create: async (conversationId) => {
        await tick();
        return inner.create(conversationId);
      },
      clear: async (conversationId) => {
        await tick();
        await inner.clear(conversationId);
      },
      load: async (conversationId) => {
        await tick();
        return inner.load(conversationId);
      },
      beginRun: async (conversationId, runId, userMessage) => {
        await tick();
        await inner.beginRun(conversationId, runId, userMessage);
      },
      beginReplyRun: async (conversationId, runId) => {
        await tick();
        return inner.beginReplyRun(conversationId, runId);
      },
      appendUserMessage: async (conversationId, userMessage) => {
        await tick();
        await inner.appendUserMessage(conversationId, userMessage);
      },
      beginEphemeralRun: async (conversationId, runId, userMessage) => {
        await tick();
        await inner.beginEphemeralRun(conversationId, runId, userMessage);
      },
      appendEvent: async (event) => {
        await tick();
        return inner.appendEvent(event);
      },
      finishRun: async (conversationId, runId, status) => {
        await tick();
        await inner.finishRun(conversationId, runId, status);
      },
      readAfter: async (conversationId, revision) => {
        await tick();
        return inner.readAfter(conversationId, revision);
      },
      subscribe: (listener) => inner.subscribe(listener),
    };
    const raceChanges: ConversationChange[] = [];
    const racing = new ChatConversationRuntime({
      emit: (change) => raceChanges.push(change),
      createTools: createAuthorizedConversationTools,
      store,
    });
    racing.configure({ chat: endpoint(serverPort), answer: endpoint(serverPort) });
    try {
      const settled = await Promise.allSettled([
        racing.runAnswer(
          "race-async-conversation",
          { text: "异步第一题", images: [] },
          ACCESS_TOKEN,
        ),
        racing.runAnswer(
          "race-async-conversation",
          { text: "异步第二题", images: [] },
          ACCESS_TOKEN,
        ),
      ]);
      const fulfilled = settled.filter(
        (outcome): outcome is PromiseFulfilledResult<{ runId: string }> =>
          outcome.status === "fulfilled",
      );
      const rejected = settled.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
      );

      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason.message).toBe("当前回复尚未完成");
      expect(fulfilled).toHaveLength(1);

      const survivorRunId = fulfilled[0]?.value.runId ?? "";
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const finished = raceChanges.some(
          (change) => change.type === "run-finished" && change.runId === survivorRunId,
        );
        if (finished) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const survivorEvents = raceChanges
        .flatMap((change) => (change.type === "event" ? [change.event] : []))
        .filter((event) => event.runId === survivorRunId);
      expect(survivorEvents.some((event) => event.stream.type === "error")).toBe(false);
      expect(
        raceChanges.some(
          (change) => change.type === "run-finished" && change.runId === survivorRunId,
        ),
      ).toBe(true);
      // run-finished 先于验收清理（finishRun → clear）到达：activeRunCount 归零即清理
      // 完成，此时才允许读快照，否则读到的是清理前的占位消息对。
      await expect.poll(() => racing.activeRunCount, { timeout: 5_000, interval: 10 }).toBe(0);
      expect((await racing.getSnapshot("race-async-conversation")).messages).toEqual([]);
    } finally {
      racing.dispose();
    }
  });

  async function waitForTerminal(runId: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (changes.some((change) => change.type === "run-finished" && change.runId === runId))
        return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`run timed out: ${runId}`);
  }
});

describe("local endpoint runtime", () => {
  function localEndpoint(port: number) {
    return { baseUrl: `http://127.0.0.1:${port}/v1`, model: "local-model", auth: "local" as const };
  }

  function createTrackedRuntime(changes: ConversationChange[], tokenProvider?: unknown) {
    return new ChatConversationRuntime({
      emit: (change) => changes.push(change),
      createTools: createAuthorizedConversationTools,
      tokenProvider: tokenProvider as
        | ((options: { forceRefresh: boolean }) => Promise<string>)
        | undefined,
    });
  }

  async function waitForRun(changes: ConversationChange[], runId: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (changes.some((change) => change.type === "run-finished" && change.runId === runId))
        return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`run timed out: ${runId}`);
  }

  async function startServer(
    handler: (request: { authorization?: string }) => { status: number; body: string },
  ): Promise<{ server: Server; port: number }> {
    const server = createServer((request, response) => {
      const outcome = handler({ authorization: request.headers.authorization });
      response.writeHead(outcome.status, { "content-type": "text/event-stream" });
      response.end(outcome.body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    return { server, port: address.port };
  }

  it("sends the saved api key as a bearer token", async () => {
    const authorizations: Array<string | undefined> = [];
    const changes: ConversationChange[] = [];
    const { server, port } = await startServer((request) => {
      authorizations.push(request.authorization);
      return { status: 200, body: streamBody("本地回复") };
    });
    const runtime = createTrackedRuntime(changes);
    try {
      runtime.configure({ chat: localEndpoint(port), answer: localEndpoint(port) });
      const { runId } = await runtime.runAnswer(
        "local-conversation",
        { text: "hello", images: [] },
        "local-key",
      );
      await waitForRun(changes, runId);
      expect(authorizations).toEqual(["Bearer local-key"]);
    } finally {
      runtime.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("drops the authorization header when no api key is saved", async () => {
    const authorizations: Array<string | undefined> = [];
    const changes: ConversationChange[] = [];
    const { server, port } = await startServer((request) => {
      authorizations.push(request.authorization);
      return { status: 200, body: streamBody("匿名回复") };
    });
    const runtime = createTrackedRuntime(changes);
    try {
      runtime.configure({ chat: localEndpoint(port), answer: localEndpoint(port) });
      const { runId } = await runtime.runAnswer(
        "local-conversation",
        { text: "hello", images: [] },
        "",
      );
      await waitForRun(changes, runId);
      expect(authorizations).toEqual([undefined]);
    } finally {
      runtime.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("surfaces a 401 from a local endpoint as a plain error without token refresh", async () => {
    const authorizations: Array<string | undefined> = [];
    const changes: ConversationChange[] = [];
    const { server, port } = await startServer((request) => {
      authorizations.push(request.authorization);
      return {
        status: 401,
        body: JSON.stringify({
          error: { message: "invalid api key", type: "authentication_error", code: "unauthorized" },
        }),
      };
    });
    const runtime = createTrackedRuntime(changes, async () => "refreshed-token");
    try {
      runtime.configure({ chat: localEndpoint(port), answer: localEndpoint(port) });
      const { runId } = await runtime.runAnswer(
        "local-conversation",
        { text: "hello", images: [] },
        "local-key",
      );
      await waitForRun(changes, runId);
      // 本地 401 不触发令牌刷新，也不伪装成「需要登录」：服务端消息如实呈现。
      expect(authorizations).toEqual(["Bearer local-key"]);
      const events = changes.flatMap((change) => (change.type === "event" ? [change.event] : []));
      const errorChunk = events.find(
        (event) => event.runId === runId && event.stream.type === "error",
      );
      expect(
        errorChunk && errorChunk.stream.type === "error" ? errorChunk.stream.errorText : "",
      ).not.toContain("auth-required");
    } finally {
      runtime.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
