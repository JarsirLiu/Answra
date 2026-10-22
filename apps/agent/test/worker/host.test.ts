import { createServer, type Server } from "node:http";
import type { AgentCommand, AgentFrame, AgentTransport, TenVadSource } from "@answra/agent";
import { startAgentHost } from "@answra/agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationId, sessionId, utteranceId } from "../../src/interview/contracts";
import {
  hopProgram,
  makeFrame,
  scriptedVadEngine,
  TEST_FRAME_SAMPLES,
} from "../interview/vad/fixtures";

/** 假转录引擎：返回固定文本，证明宿主接线不依赖真实模型。 */
const scriptedRecognizer = (text: string) => ({
  load: async () => ({
    module: {
      create: (_recipe: unknown) => ({
        transcribeOnce: () => text,
      }),
    },
    recipe: { modelPath: "model.int8.onnx", tokensPath: "tokens.txt", numThreads: 1 },
  }),
});

/** 无语音假 VAD：所有 hop 判为非语音，证明宿主接线不依赖真实推理。 */
const silenceVadSource = (): TenVadSource => ({
  load: async () => ({
    hopSamples: 256,
    createHop: () => ({
      hopSamples: 256,
      processHop: () => ({ probability: 0.02, voiced: false }),
    }),
    destroyHop: () => undefined,
  }),
});

/** 假传输：记录上行帧、允许下行命令。证明命令分发不依赖 Electron。 */
function createHarness() {
  const frames: AgentFrame[] = [];
  const close = vi.fn();
  let listener: ((command: AgentCommand) => void) | undefined;
  const transport: AgentTransport = {
    send: (frame) => void frames.push(frame),
    onCommand: (next) => {
      listener = next;
    },
    close,
  };
  return {
    transport,
    frames,
    close,
    dispatch: (command: AgentCommand) => listener?.(command),
    responses: () => frames.filter((frame) => frame.type === "response"),
    tokenRequests: () => frames.filter((frame) => frame.type === "token-request"),
  };
}

describe("agent worker host", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("publishes typed interview domain events over the worker transport", () => {
    const harness = createHarness();
    const host = startAgentHost({
      transport: harness.transport,
      vad: silenceVadSource(),
      recognizer: scriptedRecognizer("识别文本"),
    });
    const event = {
      type: "session-started" as const,
      sessionId: sessionId("capture-1"),
      conversationId: conversationId("active-exam-conversation"),
    };

    host.emitInterviewEvent(event);

    expect(harness.frames).toContainEqual({
      version: 1,
      type: "interview-event",
      event,
    });
    host.dispose();
    host.emitInterviewEvent(event);
    expect(harness.frames).toHaveLength(1);
  });

  it("projects transcript events into serializable worker DTOs", () => {
    const harness = createHarness();
    const host = startAgentHost({
      transport: harness.transport,
      vad: silenceVadSource(),
      recognizer: scriptedRecognizer("识别文本"),
    });
    host.emitInterviewEvent({
      type: "transcript-event",
      event: {
        kind: "partial",
        sessionId: sessionId("capture-1"),
        source: "interviewer",
        utteranceId: utteranceId("utterance-1"),
        chunkIndex: 0,
        startSample: 0,
        endSample: 1_600,
        revision: 1,
        boundary: "continuation",
        text: "请介绍一下",
      },
    });

    const frame = harness.frames[0];
    expect(frame).toMatchObject({
      version: 1,
      type: "interview-event",
      event: {
        type: "transcript-event",
        event: {
          kind: "partial",
          sessionId: "capture-1",
          utteranceId: "utterance-1",
          startSample: 0,
          endSample: 1_600,
          text: "请介绍一下",
        },
      },
    });
    expect(structuredClone(frame)).toEqual(frame);
  });

  it("routes PCM frames into ingress without a response per audio frame", async () => {
    const harness = createHarness();
    startAgentHost({
      transport: harness.transport,
      vad: silenceVadSource(),
      recognizer: scriptedRecognizer("识别文本"),
    });

    harness.dispatch({
      id: "start-1",
      type: "interview-start",
      sessionId: "capture-1",
      conversationId: "active-interview-conversation",
    });
    await vi.waitFor(() => expect(harness.responses()).toHaveLength(1));
    harness.dispatch({ id: "ready-1", type: "interview-capture-ready", sessionId: "capture-1" });
    await vi.waitFor(() => expect(harness.responses()).toHaveLength(2));

    const pcm = new Uint8Array(3_200);
    harness.dispatch({
      type: "interview-audio-frame",
      frame: {
        sessionId: "capture-1",
        source: "interviewer",
        sequence: 0,
        startSample: 0,
        sampleRate: 16_000,
        channels: 1,
        encoding: "pcm_s16le",
        pcm,
      },
    });
    harness.dispatch({
      type: "interview-audio-frame",
      frame: {
        sessionId: "capture-1",
        source: "interviewer",
        sequence: 2,
        startSample: 3_200,
        sampleRate: 16_000,
        channels: 1,
        encoding: "pcm_s16le",
        pcm,
      },
    });

    expect(harness.frames).toContainEqual({
      version: 1,
      type: "interview-event",
      event: {
        type: "audio-gap",
        sessionId: "capture-1",
        source: "interviewer",
        expectedSequence: 1,
        receivedSequence: 2,
        expectedStartSample: 1_600,
        receivedStartSample: 3_200,
      },
    });
    expect(harness.responses()).toHaveLength(2);

    for (const [sequence, startSample] of [
      [3, 4_800],
      [4, 6_400],
      [5, 8_000],
    ] as const) {
      harness.dispatch({
        type: "interview-audio-frame",
        frame: {
          sessionId: "capture-1",
          source: "interviewer",
          sequence,
          startSample,
          sampleRate: 16_000,
          channels: 1,
          encoding: "pcm_s16le",
          pcm,
        },
      });
    }
    expect(harness.frames).toContainEqual({
      version: 1,
      type: "interview-audio-credit",
      sessionId: "capture-1",
      count: 5,
    });
    expect(harness.responses()).toHaveLength(2);
  });

  it("fails the interview session explicitly when VAD resources cannot load", async () => {
    const harness = createHarness();
    startAgentHost({
      transport: harness.transport,
      vad: { load: () => Promise.reject(new Error("VAD 资源缺失，请运行 vad:prepare")) },
      recognizer: scriptedRecognizer("识别文本"),
    });

    harness.dispatch({
      id: "start-9",
      type: "interview-start",
      sessionId: "capture-9",
      conversationId: "active-interview-conversation",
    });
    await vi.waitFor(() => expect(harness.responses()).toHaveLength(1));

    expect(harness.responses()[0]).toMatchObject({
      id: "start-9",
      ok: false,
      error: expect.stringContaining("VAD 资源缺失"),
    });
    expect(harness.frames).toContainEqual({
      version: 1,
      type: "interview-event",
      event: {
        type: "session-failed",
        sessionId: "capture-9",
        conversationId: "active-interview-conversation",
        code: "runtime-failed",
      },
    });
  });

  it("fails the interview session explicitly when local transcription resources cannot load", async () => {
    const harness = createHarness();
    startAgentHost({
      transport: harness.transport,
      vad: silenceVadSource(),
      recognizer: {
        load: () => Promise.reject(new Error("ASR 资源缺失，请运行 asr:prepare")),
      },
    });

    harness.dispatch({
      id: "start-8",
      type: "interview-start",
      sessionId: "capture-8",
      conversationId: "active-interview-conversation",
    });
    await vi.waitFor(() => expect(harness.responses()).toHaveLength(1));

    expect(harness.responses()[0]).toMatchObject({
      id: "start-8",
      ok: false,
      error: expect.stringContaining("ASR 资源缺失"),
    });
    expect(harness.frames).toContainEqual({
      version: 1,
      type: "interview-event",
      event: {
        type: "session-failed",
        sessionId: "capture-8",
        conversationId: "active-interview-conversation",
        code: "runtime-failed",
      },
    });
  });

  it("transcripts decoded interviewer segments into transcript events", async () => {
    // 7 个 voiced 帧（42 hop）+ 结尾静音闭合：真实 VAD 分段后由假转录引擎产出文本。
    // 帧夹具固定 sessionId "capture-1"：与 ingress 的会话校验必须一致。
    const harness = createHarness();
    startAgentHost({
      transport: harness.transport,
      vad: scriptedVadEngine(hopProgram(138, [{ fromHop: 0, untilHop: 42 }])),
      recognizer: scriptedRecognizer("介绍项目"),
    });

    harness.dispatch({
      id: "start-2",
      type: "interview-start",
      sessionId: "capture-1",
      conversationId: "active-interview-conversation",
    });
    await vi.waitFor(() => expect(harness.responses()).toHaveLength(1));
    harness.dispatch({ id: "ready-2", type: "interview-capture-ready", sessionId: "capture-1" });
    await vi.waitFor(() => expect(harness.responses()).toHaveLength(2));

    for (let index = 0; index < 23; index += 1) {
      harness.dispatch({
        type: "interview-audio-frame",
        frame: {
          // 夹具产出 branded 领域帧（sessionId/source 为品牌类型）；worker 协议
          // 载荷是 plain DTO，展开时显式退包装。
          ...makeFrame("interviewer", index, TEST_FRAME_SAMPLES),
          sessionId: "capture-1",
          source: "interviewer",
        },
      });
    }

    await vi.waitFor(() => {
      expect(harness.frames).toContainEqual(
        expect.objectContaining({
          type: "interview-event",
          event: expect.objectContaining({
            type: "transcript-event",
            event: expect.objectContaining({
              kind: "chunk-final",
              sessionId: "capture-1",
              source: "interviewer",
              text: "介绍项目",
            }),
          }),
        }),
      );
    });
  });

  it("appends a naturally ended microphone turn as one user message without starting a run", async () => {
    const harness = createHarness();
    const host = startAgentHost({
      transport: harness.transport,
      vad: scriptedVadEngine(hopProgram(138, [{ fromHop: 0, untilHop: 42 }])),
      recognizer: scriptedRecognizer("请介绍一下你负责的项目"),
    });

    harness.dispatch({
      id: "start-mic-turn",
      type: "interview-start",
      sessionId: "capture-1",
      conversationId: "active-interview-conversation",
    });
    await vi.waitFor(() => expect(harness.responses()).toHaveLength(1));
    harness.dispatch({
      id: "ready-mic-turn",
      type: "interview-capture-ready",
      sessionId: "capture-1",
    });
    await vi.waitFor(() => expect(harness.responses()).toHaveLength(2));

    for (let index = 0; index < 23; index += 1) {
      harness.dispatch({
        type: "interview-audio-frame",
        frame: {
          ...makeFrame("candidate", index, TEST_FRAME_SAMPLES),
          sessionId: "capture-1",
        },
      });
    }

    await vi.waitFor(async () => {
      const snapshot = await host.runtime.getSnapshot("active-interview-conversation");
      expect(snapshot.messages).toEqual([
        expect.objectContaining({
          role: "user",
          text: "请介绍一下你负责的项目",
          status: "complete",
        }),
      ]);
    });
    expect(host.runtime.activeRunCount).toBe(0);
    expect(harness.frames).not.toContainEqual(
      expect.objectContaining({
        type: "change",
        change: expect.objectContaining({ type: "assistant-delta" }),
      }),
    );
    host.dispose();
  });

  async function startUnauthorizedServer(): Promise<string> {
    const server = createServer((_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: "unauthorized", type: "authentication_error", code: "unauthorized" },
        }),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    return `http://127.0.0.1:${address.port}/v1`;
  }

  it("executes commands and answers with a response frame carrying the same id", async () => {
    const harness = createHarness();
    startAgentHost({
      transport: harness.transport,
      vad: silenceVadSource(),
      recognizer: scriptedRecognizer("识别文本"),
    });

    harness.dispatch({ id: "1", type: "create-conversation", conversationId: "c1" });
    await vi.waitFor(() => expect(harness.responses()).toHaveLength(1));

    harness.dispatch({ id: "2", type: "snapshot", conversationId: "c1" });
    await vi.waitFor(() => expect(harness.responses()).toHaveLength(2));

    const [created, snapshot] = harness.responses();
    expect(created).toMatchObject({ id: "1", ok: true });
    expect(snapshot).toMatchObject({
      id: "2",
      ok: true,
      value: { conversationId: "c1", revision: 0, messages: [] },
    });
  });

  it("reports a command failure in the response frame instead of throwing", async () => {
    const harness = createHarness();
    startAgentHost({
      transport: harness.transport,
      vad: silenceVadSource(),
      recognizer: scriptedRecognizer("识别文本"),
    });

    harness.dispatch({
      id: "1",
      type: "chat-send",
      operation: "chat.send",
      profileId: "general-chat",
      conversationId: "missing",
      request: { text: "hi", images: [] },
      accessToken: "test-token",
    });
    await vi.waitFor(() => expect(harness.responses()).toHaveLength(1));

    expect(harness.responses()[0]).toMatchObject({
      id: "1",
      ok: false,
      error: "云端模型服务尚未就绪",
    });
  });

  it("asks the host for a fresh token on 401 and answers its own reverse request", async () => {
    const baseUrl = await startUnauthorizedServer();
    const harness = createHarness();
    const host = startAgentHost({
      transport: harness.transport,
      vad: silenceVadSource(),
      recognizer: scriptedRecognizer("识别文本"),
    });
    host.runtime.configure({
      chat: { baseUrl, model: "text.chat" },
      answer: { baseUrl, model: "image.answer" },
    });

    harness.dispatch({
      id: "1",
      type: "chat-send",
      operation: "chat.send",
      profileId: "general-chat",
      conversationId: "c1",
      request: { text: "hi", images: [] },
      accessToken: "stale-token",
    });

    // 反向请求必须由宿主（desktop main）回答：agent 自己不持有刷新能力。
    let answered = false;
    await vi.waitFor(() => {
      const [request] = harness.tokenRequests();
      expect(request).toBeDefined();
      if (answered || request?.type !== "token-request") return;
      answered = true;
      expect(request.forceRefresh).toBe(true);
      harness.dispatch({ id: request.id, type: "token", accessToken: "fresh-token" });
    });

    await vi.waitFor(() => expect(harness.responses()).toHaveLength(1));
    expect(harness.responses()[0]).toMatchObject({ id: "1", ok: true });
  });

  it("ignores a token answer that no run is waiting for", () => {
    const harness = createHarness();
    const host = startAgentHost({
      transport: harness.transport,
      vad: silenceVadSource(),
      recognizer: scriptedRecognizer("识别文本"),
    });
    const dispose = vi.spyOn(host.runtime, "dispose");

    harness.dispatch({ id: "token-request:999", type: "token", accessToken: "fresh-token" });

    expect(harness.responses()).toHaveLength(0);
    expect(dispose).not.toHaveBeenCalled();
  });

  it("disposes the runtime and closes the transport on shutdown without a response", () => {
    const harness = createHarness();
    const host = startAgentHost({
      transport: harness.transport,
      vad: silenceVadSource(),
      recognizer: scriptedRecognizer("识别文本"),
    });
    const dispose = vi.spyOn(host.runtime, "dispose");

    harness.dispatch({ id: "1", type: "shutdown" });

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(harness.close).toHaveBeenCalledTimes(1);
    expect(harness.responses()).toHaveLength(0);
  });
});
