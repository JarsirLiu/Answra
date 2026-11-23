import { createServer, type Server } from "node:http";
import { ActiveChatConversationId, ActiveExamConversationId } from "@answra/shared";
import type { LiveFrame, SessionFrame } from "@answra/shared/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screenshotAnswerAgent } from "../../src/answer/agent";
import { AnswerApplication } from "../../src/answer/application";
import { ConversationApplication } from "../../src/conversation/application";
import { createConversationBot } from "../../src/conversation/bots";
import { AgentRuntime } from "../../src/core/agent/runtime";
import { createBotCatalog } from "../../src/core/bot/catalog";
import { SessionFrameBus } from "../../src/core/session/sessionFrameBus";
import { createBuiltinToolRegistry } from "../../src/core/tool";
import { MemoryConversationStore } from "../../src/core/transcript/memoryStore";
import type { ConversationStore } from "../../src/core/transcript/store";

function createTestRuntime({
  frames,
  liveFrames = [],
  store = new MemoryConversationStore(),
  tokenProvider,
}: {
  frames: SessionFrame[];
  liveFrames?: LiveFrame[];
  store?: ConversationStore;
  tokenProvider?: (options: { forceRefresh: boolean }) => Promise<string>;
}): ConversationApplication & {
  runAnswer: AnswerApplication["run"];
  cancelAnswer: AnswerApplication["cancel"];
  readAnswerFramesAfter: AnswerApplication["readFramesAfter"];
} {
  const sessionFrames = new SessionFrameBus();
  sessionFrames.subscribe({
    onFrame: (frame) => frames.push(frame),
    onLiveFrame: (frame) => liveFrames.push(frame),
  });
  const agentRuntime = new AgentRuntime({ tokenProvider });
  const conversationBot = createConversationBot({
    agentRuntime,
    store,
    tools: createBuiltinToolRegistry(),
  });
  const runtime = new ConversationApplication({
    agentRuntime,
    store,
    catalog: createBotCatalog([conversationBot]),
  });
  const answer = new AnswerApplication({
    agentRuntime,
    store,
    executor: agentRuntime.registerAgent(screenshotAnswerAgent),
    authorAgentId: screenshotAnswerAgent.id,
    sessionFrames,
  });
  return Object.assign(runtime, {
    runAnswer: answer.run.bind(answer),
    cancelAnswer: answer.cancel.bind(answer),
    readAnswerFramesAfter: answer.readFramesAfter.bind(answer),
  });
}

type RecordedRequest = {
  messages: Array<{ role: string; content: unknown }>;
  tools?: unknown;
  temperature?: number;
  reasoningEffort?: string;
  authorization?: string;
};

const ACCESS_TOKEN = "test-access-token";

function answerTurnFrames(frames: SessionFrame[], turnId: string): SessionFrame[] {
  return frames.filter((frame) => frame.turnId === turnId);
}

function answerTerminal(frames: SessionFrame[], turnId: string): SessionFrame | undefined {
  return frames.find(
    (frame) =>
      frame.turnId === turnId &&
      frame.event.type === "session-item" &&
      frame.event.item.payload.kind === "turn-end",
  );
}

function turnEndItem(frame: SessionFrame | undefined) {
  if (frame?.event.type !== "session-item" || frame.event.item.payload.kind !== "turn-end") {
    return undefined;
  }
  return frame.event.item;
}

function isFulfilled<T>(result: PromiseSettledResult<T>): result is PromiseFulfilledResult<T> {
  return result.status === "fulfilled";
}

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
  let runtime: ReturnType<typeof createTestRuntime>;
  let frames: SessionFrame[];
  let liveFrames: LiveFrame[];
  let holdResponse: boolean;
  let modelFailure: { status: number; message: string } | undefined;
  let serverPort = 0;

  beforeEach(async () => {
    requests = [];
    frames = [];
    liveFrames = [];
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
    runtime = createTestRuntime({
      frames,
      liveFrames,
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
    expect(first.turnId).toBeTruthy();
    await waitForTerminal(first.turnId);
    const second = await runtime.runAnswer(
      "test-conversation",
      { text: "只看问题 B", images: [] },
      ACCESS_TOKEN,
    );
    await waitForTerminal(second.turnId);

    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[0]?.messages)).toContain("解释截图 A");
    expect(JSON.stringify(requests[0]?.messages)).toContain("image_url");
    expect(JSON.stringify(requests[1]?.messages)).toContain("只看问题 B");
    expect(JSON.stringify(requests[1]?.messages)).not.toContain("解释截图 A");

    // 一次性会话：成功轮结束后 transcript 与 journal 都已清空，内存不随轮次增长。
    expect((await runtime.getSnapshot("test-conversation")).messages).toEqual([]);
    expect(await runtime.readAnswerFramesAfter("test-conversation", 0)).toEqual([]);

    const firstFrames = answerTurnFrames(frames, first.turnId);
    expect(firstFrames[0]?.event.type).toBe("session-item");
    const baseSeq = firstFrames[0]?.seq ?? 0;
    expect(firstFrames.map((frame, index) => frame.seq - index)).toEqual(
      firstFrames.map(() => baseSeq),
    );
    expect(answerTerminal(frames, first.turnId)?.event).toMatchObject({
      type: "session-item",
      item: { status: "complete", payload: { kind: "turn-end", reason: "completed" } },
    });
    expect(answerTerminal(frames, second.turnId)?.event).toMatchObject({
      type: "session-item",
      item: { status: "complete", payload: { kind: "turn-end", reason: "completed" } },
    });
    expect(
      liveFrames.some(
        (frame) => frame.event.type === "reasoning-delta" && frame.event.delta === "分析中",
      ),
    ).toBe(true);
    expect(
      liveFrames.some((frame) => frame.event.type === "text-delta" && frame.event.delta === "收到"),
    ).toBe(true);
  });

  it("sets answer temperature and low reasoning effort without changing general chat", async () => {
    const answer = await runtime.runAnswer(
      "answer-tuning-conversation",
      { text: "这道题选什么", images: [] },
      ACCESS_TOKEN,
    );
    await waitForTerminal(answer.turnId);
    expect(requests.at(-1)).toMatchObject({ temperature: 0.3, reasoningEffort: "low" });

    const chat = await runtime.sendChat(
      "general-chat",
      "chat-tuning-conversation",
      { text: "普通聊天", images: [] },
      ACCESS_TOKEN,
    );
    await runtime.waitForTurn("chat-tuning-conversation", chat.turnId);
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
    await waitForTerminal(failed.turnId);

    const snapshot = await runtime.getSnapshot("failed-conversation");
    expect(snapshot.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(snapshot.messages[0]?.text).toBe("这道题选什么");
    expect(turnEndItem(answerTerminal(frames, failed.turnId))?.payload).toMatchObject({
      kind: "turn-end",
      errorText: expect.stringContaining("No model service"),
    });

    modelFailure = undefined;
    const recovered = await runtime.runAnswer(
      "failed-conversation",
      { text: "第二题", images: [] },
      ACCESS_TOKEN,
    );
    await waitForTerminal(recovered.turnId);
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
    await runtime.waitForTurn(ActiveChatConversationId, first.turnId);
    const second = await runtime.sendChat(
      "general-chat",
      ActiveChatConversationId,
      {
        text: "我叫什么？",
        images: [],
      },
      ACCESS_TOKEN,
    );
    await runtime.waitForTurn(ActiveChatConversationId, second.turnId);

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
    await waitForTerminal(answer.turnId);

    const answerPayload = JSON.stringify(requests[2]?.messages);
    expect(answerPayload).toContain("只回答当前截图问题");
    expect(answerPayload).not.toContain("我叫小明");
  });

  it("sends only profile-authorized Read, Grep, and Edit schemas to the model", async () => {
    const chat = await runtime.sendChat(
      "general-chat",
      "tools-authorized-chat",
      { text: "读取工作区", images: [] },
      ACCESS_TOKEN,
    );
    await runtime.waitForTurn("tools-authorized-chat", chat.turnId);
    const chatTools = JSON.stringify(requests.at(-1)?.tools);
    expect(chatTools).toContain("Read");
    expect(chatTools).toContain("Grep");
    expect(chatTools).toContain("Edit");
    expect(chatTools).toContain("file_path");
    expect(chatTools).toContain("pattern");
    expect(chatTools).toContain("old_string");
    expect(chatTools).toContain("new_string");
    expect(chatTools).not.toContain("list_workspace_files");

    const answer = await runtime.runAnswer(
      "tools-unauthorized-answer",
      { text: "只回答当前截图问题", images: [] },
      ACCESS_TOKEN,
    );
    await waitForTerminal(answer.turnId);
    expect(requests.at(-1)?.tools).toBeUndefined();
  });

  it("injects the current workspace root into chat turns and follows directory changes", async () => {
    runtime.setWorkspaceRoot("D:/notes/first");
    const first = await runtime.sendChat(
      "general-chat",
      "workspace-context-chat",
      { text: "工作区是什么？", images: [] },
      ACCESS_TOKEN,
    );
    await runtime.waitForTurn("workspace-context-chat", first.turnId);
    expect(JSON.stringify(requests.at(-1))).toContain("当前工作区根目录：D:/notes/first");

    runtime.setWorkspaceRoot("D:/notes/second");
    const second = await runtime.sendChat(
      "general-chat",
      "workspace-context-chat",
      { text: "现在工作区是什么？", images: [] },
      ACCESS_TOKEN,
    );
    await runtime.waitForTurn("workspace-context-chat", second.turnId);
    expect(JSON.stringify(requests.at(-1))).toContain("D:/notes/second");
    expect(JSON.stringify(requests.at(-1))).not.toContain("D:/notes/first");

    runtime.setWorkspaceRoot(null);
    const third = await runtime.sendChat(
      "general-chat",
      "workspace-context-chat",
      { text: "还能读文件吗？", images: [] },
      ACCESS_TOKEN,
    );
    await runtime.waitForTurn("workspace-context-chat", third.turnId);
    expect(JSON.stringify(requests.at(-1))).toContain("尚未选择工作区目录");

    const answer = await runtime.runAnswer(
      "workspace-context-answer",
      { text: "答题", images: [] },
      ACCESS_TOKEN,
    );
    await waitForTerminal(answer.turnId);
    expect(JSON.stringify(requests.at(-1))).not.toContain("当前工作区根目录");
    expect(JSON.stringify(requests.at(-1))).not.toContain("尚未选择工作区目录");
  });

  it("injects runtime environment before the workspace only for tool-enabled chat profiles", async () => {
    const { turnId } = await runtime.sendChat(
      "general-chat",
      "environment-context-chat",
      { text: "你运行在什么环境？", images: [] },
      ACCESS_TOKEN,
    );
    await runtime.waitForTurn("environment-context-chat", turnId);

    const chatBody = JSON.stringify(requests.at(-1));
    expect(chatBody).toContain("# 运行环境");
    expect(chatBody).toContain("操作系统：");
    expect(chatBody).toContain("Shell：");
    expect(chatBody).toContain("命令语法：");
    expect(chatBody.indexOf("# 运行环境")).toBeLessThan(chatBody.indexOf("# 工作区"));

    const answer = await runtime.runAnswer(
      "environment-context-answer",
      { text: "答题", images: [] },
      ACCESS_TOKEN,
    );
    await waitForTerminal(answer.turnId);
    expect(JSON.stringify(requests.at(-1))).not.toContain("# 运行环境");
  });

  it("injects current local time and time zone only for chat profiles", async () => {
    const { turnId } = await runtime.sendChat(
      "general-chat",
      "time-inject-chat",
      {
        text: "今天几号？",
        images: [],
      },
      ACCESS_TOKEN,
    );
    await runtime.waitForTurn("time-inject-chat", turnId);

    const chatBody = JSON.stringify(requests.at(-1));
    expect(chatBody).toContain("<system-reminder>");
    expect(chatBody).toContain("# currentTime");
    expect(chatBody).toContain("Current local time:");
    expect(chatBody).toContain("Current UTC time:");
    expect(chatBody).toContain("Do not infer how long ago earlier messages were sent");

    const answer = await runtime.runAnswer(
      "time-inject-exam",
      {
        text: "答题",
        images: [],
      },
      ACCESS_TOKEN,
    );
    await waitForTerminal(answer.turnId);
    const answerBody = JSON.stringify(requests.at(-1));
    expect(answerBody).not.toContain("# currentTime");
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
    expect(frames).toHaveLength(0);
  });

  it("aborts an active request and releases its temporary run state", async () => {
    holdResponse = true;
    const { turnId } = await runtime.runAnswer(
      "test-conversation",
      { text: "请取消", images: [] },
      ACCESS_TOKEN,
    );
    runtime.cancelAnswer("test-conversation", turnId);
    await waitForTerminal(turnId);

    expect(answerTerminal(frames, turnId)?.event).toMatchObject({
      type: "session-item",
      item: { status: "interrupted", payload: { kind: "turn-end", reason: "cancelled" } },
    });
    await expect
      .poll(() => runtime.readAnswerFramesAfter("test-conversation", 0), {
        timeout: 5_000,
        interval: 10,
      })
      .toEqual([]);
    expect((await runtime.getSnapshot("test-conversation")).messages).toEqual([]);
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

    const { turnId } = await runtime.runAnswer(
      "test-conversation",
      { text: "hello", images: [] },
      ACCESS_TOKEN,
    );
    await waitForTerminal(turnId);

    expect(turnEndItem(answerTerminal(frames, turnId))?.payload).toMatchObject({
      kind: "turn-end",
      errorText: expect.stringContaining("auth-required"),
    });
    expect(answerTerminal(frames, turnId)?.event).toMatchObject({
      type: "session-item",
      item: { status: "failed", payload: { kind: "turn-end" } },
    });
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

    const retryFrames: SessionFrame[] = [];
    const retryLiveFrames: LiveFrame[] = [];
    const retrying = createTestRuntime({
      frames: retryFrames,
      liveFrames: retryLiveFrames,
      tokenProvider: async (options) => {
        forceRefreshFlags.push(options.forceRefresh);
        return "refreshed-token";
      },
    });
    try {
      retrying.configure({ chat: endpoint(address.port), answer: endpoint(address.port) });
      const { turnId } = await retrying.runAnswer(
        "retry-conversation",
        { text: "hello", images: [] },
        "stale-token",
      );
      await waitForTerminal(turnId, retryFrames);

      expect(authorizations).toEqual(["Bearer stale-token", "Bearer refreshed-token"]);
      expect(forceRefreshFlags).toEqual([true]);
      expect(
        retryLiveFrames.some(
          (frame) => frame.event.type === "text-delta" && frame.event.delta === "重试成功",
        ),
      ).toBe(true);
      expect(retryFrames.some((frame) => frame.event.type === "error")).toBe(false);
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

    const retryFrames: SessionFrame[] = [];
    const retrying = createTestRuntime({
      frames: retryFrames,
      tokenProvider: async () => "refreshed-token",
    });
    try {
      retrying.configure({ chat: endpoint(address.port), answer: endpoint(address.port) });
      const { turnId } = await retrying.runAnswer(
        "retry-conversation",
        { text: "hello", images: [] },
        "stale-token",
      );
      await waitForTerminal(turnId, retryFrames);

      expect(attempts).toEqual(["Bearer stale-token", "Bearer refreshed-token"]);
      const terminal = turnEndItem(answerTerminal(retryFrames, turnId));
      expect(terminal?.payload).toMatchObject({
        kind: "turn-end",
        errorText: expect.stringContaining("auth-required"),
      });
      expect(terminal?.status).toBe("failed");
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
    const fulfilled = settled.filter(isFulfilled);
    const rejected = settled.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );

    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(Error);
    expect(rejected[0]?.reason.message).toBe("当前回复尚未完成");
    expect(fulfilled).toHaveLength(1);

    const survivorTurnId = fulfilled[0]?.value.turnId ?? "";
    await waitForTerminal(survivorTurnId);
    expect(answerTerminal(frames, survivorTurnId)?.event).toMatchObject({
      type: "session-item",
      item: { status: "complete", payload: { kind: "turn-end" } },
    });
  });

  it("keeps the single-active-run invariant when every store await spans real time", async () => {
    // SQLite 形态回归：每个端口方法真实挂起一个宏任务，分步检查再启动会破坏在途 Turn；
    // 原子认领必须保持单活动 Turn 不变量。
    const inner = new MemoryConversationStore();
    const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
    const store: ConversationStore = {
      create: async (conversationId, seed, metadata) => {
        await tick();
        return inner.create(conversationId, seed, metadata);
      },
      scopeOf: async (conversationId) => {
        await tick();
        return inner.scopeOf(conversationId);
      },
      clear: async (conversationId) => {
        await tick();
        await inner.clear(conversationId);
      },
      advanceLastSeq: async (conversationId, sequence) => {
        await tick();
        await inner.advanceLastSeq(conversationId, sequence);
      },
      refresh: async (conversationId) => {
        await tick();
        await inner.refresh(conversationId);
      },
      load: async (conversationId) => {
        await tick();
        return inner.load(conversationId);
      },
      beginSessionTurn: async (conversationId, input) => {
        await tick();
        await inner.beginSessionTurn(conversationId, input);
      },
      beginSessionAssistant: async (conversationId, messageId, authorAgentId) => {
        await tick();
        await inner.beginSessionAssistant(conversationId, messageId, authorAgentId);
      },
      applySessionStreamEvent: async (conversationId, messageId, event) => {
        await tick();
        await inner.applySessionStreamEvent(conversationId, messageId, event);
      },
      finishSessionAssistant: async (conversationId, messageId, outcome) => {
        await tick();
        await inner.finishSessionAssistant(conversationId, messageId, outcome);
      },
      finishSessionTurn: async (conversationId, turnId) => {
        await tick();
        await inner.finishSessionTurn(conversationId, turnId);
      },
      appendHandoffMessage: async (conversationId, handoff) => {
        await tick();
        return inner.appendHandoffMessage(conversationId, handoff);
      },
      setActiveAgent: async (conversationId, agentId) => {
        await tick();
        await inner.setActiveAgent(conversationId, agentId);
      },
      appendUserMessage: async (conversationId, userMessage) => {
        await tick();
        return inner.appendUserMessage(conversationId, userMessage);
      },
      loadContextState: async (conversationId) => {
        await tick();
        return inner.loadContextState(conversationId);
      },
      saveContextState: async (conversationId, state) => {
        await tick();
        await inner.saveContextState(conversationId, state);
      },
      close: async () => {
        await inner.close();
      },
    };
    const raceFrames: SessionFrame[] = [];
    const racing = createTestRuntime({
      frames: raceFrames,
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
      const fulfilled = settled.filter(isFulfilled);
      const rejected = settled.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
      );

      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason.message).toBe("当前回复尚未完成");
      expect(fulfilled).toHaveLength(1);

      const survivorTurnId = fulfilled[0]?.value.turnId ?? "";
      await waitForTerminal(survivorTurnId, raceFrames);
      expect(answerTerminal(raceFrames, survivorTurnId)?.event).toMatchObject({
        type: "session-item",
        item: { status: "complete", payload: { kind: "turn-end" } },
      });
      // 成功轮 settle 在终态帧之后释放 journal 与 transcript：等清理完成后快照必须为空。
      await expect
        .poll(() => racing.getSnapshot("race-async-conversation"), {
          timeout: 5_000,
          interval: 10,
        })
        .toMatchObject({ messages: [] });
    } finally {
      racing.dispose();
    }
  });

  async function waitForTerminal(turnId: string, source: SessionFrame[] = frames): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (answerTerminal(source, turnId) !== undefined) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`turn timed out: ${turnId}`);
  }
});

describe("local endpoint runtime", () => {
  function localEndpoint(port: number) {
    return { baseUrl: `http://127.0.0.1:${port}/v1`, model: "local-model", auth: "local" as const };
  }

  function createTrackedRuntime(frames: SessionFrame[], tokenProvider?: unknown) {
    return createTestRuntime({
      frames,
      tokenProvider: tokenProvider as
        | ((options: { forceRefresh: boolean }) => Promise<string>)
        | undefined,
    });
  }

  async function waitForRun(frames: SessionFrame[], turnId: string): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (answerTerminal(frames, turnId) !== undefined) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`turn timed out: ${turnId}`);
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
    const frames: SessionFrame[] = [];
    const { server, port } = await startServer((request) => {
      authorizations.push(request.authorization);
      return { status: 200, body: streamBody("本地回复") };
    });
    const runtime = createTrackedRuntime(frames);
    try {
      runtime.configure({ chat: localEndpoint(port), answer: localEndpoint(port) });
      const { turnId } = await runtime.runAnswer(
        "local-conversation",
        { text: "hello", images: [] },
        "local-key",
      );
      await waitForRun(frames, turnId);
      expect(authorizations).toEqual(["Bearer local-key"]);
    } finally {
      runtime.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("drops the authorization header when no api key is saved", async () => {
    const authorizations: Array<string | undefined> = [];
    const frames: SessionFrame[] = [];
    const { server, port } = await startServer((request) => {
      authorizations.push(request.authorization);
      return { status: 200, body: streamBody("匿名回复") };
    });
    const runtime = createTrackedRuntime(frames);
    try {
      runtime.configure({ chat: localEndpoint(port), answer: localEndpoint(port) });
      const { turnId } = await runtime.runAnswer(
        "local-conversation",
        { text: "hello", images: [] },
        "",
      );
      await waitForRun(frames, turnId);
      expect(authorizations).toEqual([undefined]);
    } finally {
      runtime.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("surfaces a 401 from a local endpoint as a plain error without token refresh", async () => {
    const authorizations: Array<string | undefined> = [];
    const frames: SessionFrame[] = [];
    const { server, port } = await startServer((request) => {
      authorizations.push(request.authorization);
      return {
        status: 401,
        body: JSON.stringify({
          error: { message: "invalid api key", type: "authentication_error", code: "unauthorized" },
        }),
      };
    });
    const runtime = createTrackedRuntime(frames, async () => "refreshed-token");
    try {
      runtime.configure({ chat: localEndpoint(port), answer: localEndpoint(port) });
      const { turnId } = await runtime.runAnswer(
        "local-conversation",
        { text: "hello", images: [] },
        "local-key",
      );
      await waitForRun(frames, turnId);
      // 本地 401 不触发令牌刷新，也不伪装成「需要登录」：服务端消息如实呈现。
      expect(authorizations).toEqual(["Bearer local-key"]);
      const payload = turnEndItem(answerTerminal(frames, turnId))?.payload;
      expect(payload && payload.kind === "turn-end" ? payload.errorText : "").not.toContain(
        "auth-required",
      );
    } finally {
      runtime.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
