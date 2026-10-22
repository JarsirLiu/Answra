import { describe, expect, it } from "vitest";
import type { AudioSegment, TranscriptEvent } from "../../../src/interview/contracts";
import { sessionId, utteranceId } from "../../../src/interview/contracts";
import { LocalParaformerAdapter } from "../../../src/interview/transcription/local/adapter";
import type {
  OfflineRecognizerModule,
  OfflineRecognizerRecipe,
  OfflineRecognizerSession,
} from "../../../src/interview/transcription/local/recognizerPort";
import { TranscriptionPump } from "../../../src/interview/transcription/pump";

/**
 * 转录泵：分段按到达顺序串行解码；会话停止后迟到分段与在途结果一律丢弃；
 * dispose 取消全部在途解码。"同步解码完成才取消"的真实形态由 behavior
 * 在解码钩子内触发 stop/dispose 复现（adapter 的 cancelled 语义另测）。
 */

const SESSION_ID = sessionId("pump-session");
const UTTERANCE_ID = utteranceId("pump-utterance");
const SAMPLE_RATE = 16_000 satisfies 16_000;

function segmentFixture(startSample: number, endSample: number, chunkIndex = 0): AudioSegment {
  return {
    sessionId: SESSION_ID,
    source: "interviewer",
    utteranceId: UTTERANCE_ID,
    chunkIndex,
    startSample,
    endSample,
    sampleRate: SAMPLE_RATE,
    channels: 1,
    encoding: "pcm_s16le",
    pcm: new Uint8Array((endSample - startSample) * 2),
    boundary: "utterance-end",
  };
}

function adapterWithHook(hook?: () => void, order: string[] = []): LocalParaformerAdapter {
  const module: OfflineRecognizerModule = {
    create(): OfflineRecognizerSession {
      return {
        transcribeOnce(input: { samples: Float32Array; sampleRate: number }): string {
          order.push(String(input.samples.length));
          hook?.();
          return input.samples.length.toString(10);
        },
      };
    },
  };
  const recipe: OfflineRecognizerRecipe = {
    modelPath: "model.int8.onnx",
    tokensPath: "tokens.txt",
    numThreads: 1,
  };
  return new LocalParaformerAdapter({ module, recipe });
}

function pumpHarness(): {
  pump: TranscriptionPump;
  events: TranscriptEvent[];
} {
  const events: TranscriptEvent[] = [];
  const pump = new TranscriptionPump({ emit: (event) => events.push(event) });
  return { pump, events };
}

/** 确定性排空：解码链只由微任务构成，一个宏任务跳过后必已全部结算。
 * 负向断言（"不会再有事件"）用它，不用真实毫秒睡眠当同步点。 */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("TranscriptionPump（转录泵）", () => {
  it("分段按到达顺序串行解码并把事件投出", async () => {
    const { pump, events } = pumpHarness();
    const order: string[] = [];
    const adapter = adapterWithHook(undefined, order);
    pump.start(SESSION_ID, adapter);
    // 段样式：用样本量编码身份（6400 / 9600 两个不同段）；均超过引擎最小时长。
    pump.handleSegment(segmentFixture(0, 6_400));
    pump.handleSegment(segmentFixture(6_400, 16_000, 1));
    await settle();

    expect(events.map((event) => ("text" in event ? event.text : "?"))).toEqual([
      String(6_400),
      String(9_600),
    ]);
    expect(order).toEqual([String(6_400), String(9_600)]);
    expect(events.every((event) => event.kind === "chunk-final")).toBe(true);
  });

  it("stop 后到达的分段不再解码", async () => {
    const { pump, events } = pumpHarness();
    const order: string[] = [];
    const adapter = adapterWithHook(undefined, order);
    pump.start(SESSION_ID, adapter);
    pump.stop(SESSION_ID);
    pump.handleSegment(segmentFixture(0, 12_800));
    await settle();
    expect(order).toEqual([]);
    expect(events).toEqual([]);
  });

  it("停止前的在途解码：结果到达时会话已停，事件被丢弃", async () => {
    const { pump, events } = pumpHarness();
    const order: string[] = [];
    // 解码钩子内触发 stop：复现“同步解码完成、事件才迟到”的边界。
    const adapter = adapterWithHook(() => pump.stop(SESSION_ID), order);
    pump.start(SESSION_ID, adapter);
    pump.handleSegment({ ...segmentFixture(0, 12_800), pcm: new Uint8Array(12_800 * 2) });
    await settle();
    expect(order).toEqual([String(12_800)]);
    expect(events).toEqual([]);
  });

  it("dispose 取消全部会话：在途结果也不投递", async () => {
    const { pump, events } = pumpHarness();
    const order: string[] = [];
    const adapter = adapterWithHook(() => pump.dispose(), order);
    pump.start(SESSION_ID, adapter);
    pump.handleSegment({ ...segmentFixture(0, 12_800), pcm: new Uint8Array(12_800 * 2) });
    pump.handleSegment(segmentFixture(12_800, 16_800, 1));
    await settle();
    expect(events).toEqual([]);
  });
});
