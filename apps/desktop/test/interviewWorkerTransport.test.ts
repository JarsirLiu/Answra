import type { AgentCommand, AgentFrame, RecognizerSource, TenVadSource } from "@answra/agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startAgentWorker } from "../src/main/conversation/workerTransport";

/** 无语音假 VAD：所有 hop 判为非语音，证明传输接线不依赖真实推理。 */
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

/** 假转录装配：返回伪文本的引擎，证明 utility process 传输接线不依赖真实模型。 */
const scriptedRecognizer = (): RecognizerSource => ({
  load: async () => ({
    module: {
      create: () => ({
        transcribeOnce: () => "识别文本",
      }),
    },
    recipe: { modelPath: "model.int8.onnx", tokensPath: "tokens.txt", numThreads: 1 },
  }),
});

interface ParentMessage {
  data: AgentCommand;
}

function createParentPort() {
  const frames: AgentFrame[] = [];
  let listener: ((event: ParentMessage) => void) | undefined;
  const parentPort = {
    postMessage: (frame: AgentFrame) => frames.push(structuredClone(frame)),
    on: (_event: "message", next: (event: ParentMessage) => void) => {
      listener = next;
      return parentPort;
    },
  };

  return {
    parentPort: parentPort as unknown as Electron.ParentPort,
    frames,
    dispatch(command: AgentCommand) {
      listener?.({ data: structuredClone(command) });
    },
  };
}

function audioFrame(sessionId: string, sequence: number): AgentCommand {
  return {
    type: "interview-audio-frame",
    frame: {
      sessionId,
      source: "interviewer",
      sequence,
      startSample: sequence * 1_600,
      sampleRate: 16_000,
      channels: 1,
      encoding: "pcm_s16le",
      pcm: new Uint8Array(3_200),
    },
  };
}

describe("Agent worker interview audio transport", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns batch credits, reports gaps, and rejects frames from a stopped session after restart", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const harness = createParentPort();
    const host = startAgentWorker(harness.parentPort, {
      vad: silenceVadSource(),
      recognizer: scriptedRecognizer(),
    });

    harness.dispatch({
      id: "start-1",
      type: "interview-start",
      sessionId: "capture-1",
      conversationId: "active-interview-conversation",
    });
    await vi.waitFor(() => expect(response(harness.frames, "start-1")?.ok).toBe(true));
    harness.dispatch({ id: "ready-1", type: "interview-capture-ready", sessionId: "capture-1" });
    await vi.waitFor(() => expect(response(harness.frames, "ready-1")?.ok).toBe(true));

    harness.dispatch(audioFrame("capture-1", 0));
    harness.dispatch(audioFrame("capture-1", 2));
    harness.dispatch(audioFrame("capture-1", 3));
    harness.dispatch(audioFrame("capture-1", 4));
    harness.dispatch(audioFrame("capture-1", 5));

    await vi.waitFor(() => expect(credit(harness.frames, "capture-1")?.count).toBe(5));
    expect(gaps(harness.frames)).toEqual([
      expect.objectContaining({
        sessionId: "capture-1",
        expectedSequence: 1,
        receivedSequence: 2,
        expectedStartSample: 1_600,
        receivedStartSample: 3_200,
      }),
    ]);
    expect(responses(harness.frames)).toHaveLength(2);

    harness.dispatch(audioFrame("capture-1", 6));
    harness.dispatch(audioFrame("capture-1", 6));
    for (let sequence = 7; sequence < 11; sequence += 1)
      harness.dispatch(audioFrame("capture-1", sequence));
    await vi.waitFor(() =>
      expect(
        harness.frames.filter(
          (frame) => frame.type === "interview-audio-credit" && frame.sessionId === "capture-1",
        ),
      ).toHaveLength(2),
    );
    expect(
      harness.frames
        .filter(
          (frame) => frame.type === "interview-audio-credit" && frame.sessionId === "capture-1",
        )
        .map((frame) => (frame.type === "interview-audio-credit" ? frame.count : 0)),
    ).toEqual([5, 5]);

    harness.dispatch({ id: "stop-1", type: "interview-stop", sessionId: "capture-1" });
    await vi.waitFor(() => expect(response(harness.frames, "stop-1")?.ok).toBe(true));
    harness.dispatch({
      id: "start-2",
      type: "interview-start",
      sessionId: "capture-2",
      conversationId: "active-interview-conversation",
    });
    await vi.waitFor(() => expect(response(harness.frames, "start-2")?.ok).toBe(true));
    harness.dispatch({ id: "ready-2", type: "interview-capture-ready", sessionId: "capture-2" });
    await vi.waitFor(() => expect(response(harness.frames, "ready-2")?.ok).toBe(true));

    harness.dispatch(audioFrame("capture-1", 6));
    for (let sequence = 0; sequence < 5; sequence += 1)
      harness.dispatch(audioFrame("capture-2", sequence));

    await vi.waitFor(() => expect(credit(harness.frames, "capture-2")?.count).toBe(5));
    expect(credit(harness.frames, "capture-1")?.count).toBe(5);
    expect(gaps(harness.frames)).toHaveLength(1);
    expect(responses(harness.frames)).toHaveLength(5);
    host.dispose();
  });
});

function responses(frames: AgentFrame[]) {
  return frames.filter((frame) => frame.type === "response");
}

function response(frames: AgentFrame[], id: string) {
  return responses(frames).find((frame) => frame.type === "response" && frame.id === id);
}

function credit(frames: AgentFrame[], sessionId: string) {
  return frames.find(
    (frame) => frame.type === "interview-audio-credit" && frame.sessionId === sessionId,
  );
}

function gaps(frames: AgentFrame[]) {
  return frames.flatMap((frame) =>
    frame.type === "interview-event" && frame.event.type === "audio-gap" ? [frame.event] : [],
  );
}
