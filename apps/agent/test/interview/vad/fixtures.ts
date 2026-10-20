import { vi } from "vitest";
import type { AudioSource, PcmFrame } from "../../../src/interview/contracts";
import { sessionId } from "../../../src/interview/contracts";
import { TEN_VAD_HOP_SAMPLES } from "../../../src/interview/vad/config";
import type {
  HopVerdict,
  TenVadEngine,
  TenVadHop,
  TenVadSource,
} from "../../../src/interview/vad/tenVadEngine";

/**
 * VAD 测试夹具：帧长取 1536 样本（= 6 个 hop），让 hop 时序与帧对齐、方便用
 * 「hop 下标」直接描述语音区间。事件 atSample 与 hop 起点一一对应（k*256）。
 */

export const TEST_FRAME_SAMPLES = 1_536;
export const TEST_SESSION = sessionId("capture-1");
export const HOPS_PER_FRAME = TEST_FRAME_SAMPLES / TEN_VAD_HOP_SAMPLES;

type SampleValue = (sample: number) => number;

export function loudSpeechValue(sample: number): number {
  return sample % 2 === 0 ? 3_000 : -3_000;
}

export function makePcmBytes(
  sampleCount: number,
  valueAt: SampleValue,
  startSample = 0,
): Uint8Array {
  const bytes = new Uint8Array(sampleCount * 2);
  for (let i = 0; i < sampleCount; i += 1) {
    new DataView(bytes.buffer).setInt16(i * 2, valueAt(startSample + i), true);
  }
  return bytes;
}

export function makeFrame(
  source: AudioSource,
  sequence: number,
  samples: number,
  valueAt: SampleValue = () => 0,
  startSample?: number,
): PcmFrame {
  const base = startSample ?? sequence * TEST_FRAME_SAMPLES;
  return {
    sessionId: TEST_SESSION,
    source,
    sequence,
    startSample: base,
    sampleRate: 16_000,
    channels: 1,
    encoding: "pcm_s16le",
    pcm: makePcmBytes(samples, valueAt, base),
  };
}

export function makeSilenceFrames(source: AudioSource, frameCount: number): PcmFrame[] {
  return Array.from({ length: frameCount }, (_unused, index) =>
    makeFrame(source, index, TEST_FRAME_SAMPLES),
  );
}

export interface VoiceSpan {
  fromHop: number;
  /** 含头不含尾：最后一个 voiced hop 是 untilHop-1。 */
  untilHop: number;
  probability?: number;
}

/** 用 voice 区间展开成逐 hop 判决序列；区间外 probability=0.02、voiced=false。 */
export function hopProgram(totalHops: number, spans: VoiceSpan[] = []): HopVerdict[] {
  return Array.from({ length: totalHops }, (_unused, hop) => {
    for (const span of spans) {
      if (hop >= span.fromHop && hop < span.untilHop)
        return { probability: span.probability ?? 0.99, voiced: true };
    }
    return { probability: 0.02, voiced: false };
  });
}

/** 把判决序列交给消耗型 hop；超出的 hop 会显式报错，避免测试静默错位。 */
export function scriptedHop(program: HopVerdict[]): TenVadHop {
  let nextHop = 0;
  return {
    hopSamples: TEN_VAD_HOP_SAMPLES,
    processHop(samples) {
      if (samples.byteLength !== TEN_VAD_HOP_SAMPLES * 2)
        throw new TypeError("夹具 hop 期望 256 样本");
      const verdict = program[nextHop];
      nextHop += 1;
      if (!verdict) throw new Error(`夹具判决序列耗尽（hop=${nextHop - 1}）`);
      return verdict;
    },
  };
}

export function scriptedVadEngine(program: HopVerdict[]): TenVadSource {
  const destroyHop = vi.fn();
  const engine: TenVadEngine = {
    hopSamples: TEN_VAD_HOP_SAMPLES,
    createHop: () => scriptedHop(program),
    destroyHop,
  };
  return { load: async () => engine };
}
