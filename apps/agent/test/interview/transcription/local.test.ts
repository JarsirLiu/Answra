import { describe, expect, it } from "vitest";
import {
  type AudioSegment,
  utteranceId as newUtteranceId,
  sessionId,
  type TranscriptionErrorCode,
} from "../../../src/interview/contracts";
import {
  LocalParaformerAdapter,
  type LocalParaformerProviderOptions,
} from "../../../src/interview/transcription/local/adapter";
import type {
  OfflineRecognizerRecipe,
  OfflineRecognizerSession,
} from "../../../src/interview/transcription/local/recognizerPort";

/** 假引擎：记录调用与喂入音频，可配置解码失败与解码中的取消时机，不加载真模型。 */
class FakeSession implements OfflineRecognizerSession {
  accepted: { samples: Float32Array; sampleRate: number }[] = [];
  decodeCount = 0;
  result = "";
  failOnDecode = false;
  abortDuringDecode?: AbortController;

  transcribeOnce(input: { samples: Float32Array; sampleRate: number }): string {
    this.accepted.push(input);
    this.decodeCount += 1;
    this.abortDuringDecode?.abort();
    if (this.failOnDecode) throw new Error("engine reshape failure");
    return this.result;
  }
}

function fakeModule(session: FakeSession): LocalParaformerProviderOptions {
  return {
    module: {
      create(_recipe: OfflineRecognizerRecipe): OfflineRecognizerSession {
        return session;
      },
    },
    recipe: { modelPath: "model.int8.onnx", tokensPath: "tokens.txt", numThreads: 1 },
  };
}

const SESSION_ID = sessionId("fixture-session");
const UTTERANCE_ID = newUtteranceId("fixture-utterance");
const SAMPLE_RATE = 16_000 satisfies 16_000;

/** 0.8s 全零段：超过引擎最小时长、可整段解码。 */
function segmentFixture(
  overrides: Partial<AudioSegment> = {},
  sampleCount = (800 * SAMPLE_RATE) / 1000,
): AudioSegment {
  return {
    sessionId: SESSION_ID,
    source: "interviewer",
    utteranceId: UTTERANCE_ID,
    chunkIndex: 0,
    startSample: 40_000,
    endSample: 40_000 + sampleCount,
    sampleRate: SAMPLE_RATE,
    channels: 1,
    encoding: "pcm_s16le",
    pcm: new Uint8Array(sampleCount * 2),
    boundary: "utterance-end",
    ...overrides,
  };
}

describe("LocalParaformerAdapter（阶段 2：本地批式转录 provider）", () => {
  it("把整段 AudioSegment 一次解码成携带段身份的 chunk-final 事件", async () => {
    const session = new FakeSession();
    session.result = "识别文本";
    const adapter = new LocalParaformerAdapter(fakeModule(session));
    const events = await adapter.transcribe(segmentFixture(), new AbortController().signal);

    expect(events).toEqual([
      {
        sessionId: SESSION_ID,
        source: "interviewer",
        utteranceId: UTTERANCE_ID,
        chunkIndex: 0,
        startSample: 40_000,
        endSample: 52_800,
        revision: 0,
        boundary: "utterance-end",
        kind: "chunk-final",
        text: "识别文本",
      },
    ]);
    expect(session.decodeCount).toBe(1);
    expect(session.accepted).toEqual([{ samples: new Float32Array(12_800), sampleRate: 16_000 }]);
  });

  it("跳过低于引擎最小时长的段，不触发解码也不产生事件", async () => {
    const session = new FakeSession();
    const adapter = new LocalParaformerAdapter(fakeModule(session));
    const events = await adapter.transcribe(
      segmentFixture({ chunkIndex: 3 }, 0.28 * SAMPLE_RATE),
      new AbortController().signal,
    );

    expect(events).toEqual([]);
    expect(session.decodeCount).toBe(0);
  });

  it("引擎解码抛错时归一化为可重试的 provider-error，而不是吞掉或向上抛", async () => {
    const session = new FakeSession();
    session.failOnDecode = true;
    const adapter = new LocalParaformerAdapter(fakeModule(session));
    const events = await adapter.transcribe(segmentFixture(), new AbortController().signal);

    expect(events).toEqual([
      {
        sessionId: SESSION_ID,
        source: "interviewer",
        utteranceId: UTTERANCE_ID,
        chunkIndex: 0,
        startSample: 40_000,
        endSample: 52_800,
        revision: 0,
        boundary: "utterance-end",
        kind: "error",
        code: "provider-error" satisfies TranscriptionErrorCode,
        retryable: true,
      },
    ]);
  });

  it("解码前就已取消的段返回不可重试的 cancelled，不触发引擎", async () => {
    const session = new FakeSession();
    const adapter = new LocalParaformerAdapter(fakeModule(session));
    const controller = new AbortController();
    controller.abort();
    const events = await adapter.transcribe(segmentFixture(), controller.signal);

    expect(events.some((e) => e.kind === "error" && e.code === "cancelled")).toBe(true);
    expect(session.decodeCount).toBe(0);
  });

  it("解码完成后才到达的取消信号丢弃结果并报 cancelled", async () => {
    const session = new FakeSession();
    const adapter = new LocalParaformerAdapter(fakeModule(session));
    const controller = new AbortController();
    // 模拟"解码期间收到停止请求"：引擎返回结果前 abort 已被触发，
    // 覆盖"同步解码完成后才检查到取消"的真实边界形态。
    session.abortDuringDecode = controller;
    const events = await adapter.transcribe(segmentFixture(), controller.signal);

    expect(events.some((e) => e.kind === "error" && e.code === "cancelled")).toBe(true);
    // 结果被丢弃，没有任何 chunk-final 混入。
    expect(events.some((e) => e.kind === "chunk-final")).toBe(false);
  });

  it("多 source 段各自解码互不串扰（无共享会话态）", async () => {
    const session = new FakeSession();
    session.result = "文本";
    const adapter = new LocalParaformerAdapter(fakeModule(session));
    const first = await adapter.transcribe(segmentFixture(), new AbortController().signal);
    const second = await adapter.transcribe(
      segmentFixture({ source: "candidate", startSample: 900_000, endSample: 912_800 }),
      new AbortController().signal,
    );

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]?.source).toBe("interviewer");
    expect(second[0]?.source).toBe("candidate");
    expect(session.accepted.length).toBe(2);
  });
});
