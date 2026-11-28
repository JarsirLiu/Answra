import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

class AudioWorkletProcessorHarness {
  port = { onmessage: (_event: { data: unknown }) => undefined, postMessage: vi.fn() };
}

type ProcessorInstance = AudioWorkletProcessorHarness & {
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
};

interface PostedFrame {
  type: string;
  source?: string;
  sequence?: number;
  startSample?: number;
  pcm?: ArrayBuffer;
}

function createProcessor() {
  let Processor: (new () => AudioWorkletProcessorHarness) | undefined;
  const source = readFileSync(
    fileURLToPath(new URL("../public/pcmFrameProcessor.js", import.meta.url)),
    "utf8",
  );
  runInNewContext(source, {
    AudioWorkletProcessor: AudioWorkletProcessorHarness,
    registerProcessor: (_name: string, processor: typeof Processor) => {
      Processor = processor;
    },
  });
  if (!Processor) throw new Error("PCM AudioWorklet processor was not registered");
  return new Processor();
}

function feedSamples(processor: ProcessorInstance, sampleCount: number, value = 0.25): void {
  for (let offset = 0; offset < sampleCount; offset += 128) {
    const length = Math.min(128, sampleCount - offset);
    processor.process([[new Float32Array(length).fill(value)]], [[new Float32Array(length)]]);
  }
}

function postedFrames(processor: ProcessorInstance): PostedFrame[] {
  return processor.port.postMessage.mock.calls
    .map(([message]) => message as PostedFrame)
    .filter((message) => message.type === "frame");
}

describe("PCM AudioWorklet processor", () => {
  it("keeps each stream's source label on PCM frames", () => {
    const processor = createProcessor() as ProcessorInstance;
    processor.port.onmessage({
      data: { type: "start", source: "candidate", credits: 1, maxCredits: 1 },
    });

    feedSamples(processor, 1_600);

    const [frame] = postedFrames(processor);
    expect(frame).toMatchObject({
      type: "frame",
      source: "candidate",
      sequence: 0,
      startSample: 0,
    });
    expect(frame?.pcm?.byteLength).toBe(3_200);
  });

  it("posts a level message even when credits drop the frame", () => {
    const processor = createProcessor() as ProcessorInstance;
    processor.port.onmessage({ data: { type: "start", credits: 0, maxCredits: 1 } });

    feedSamples(processor, 1_600, 0.5);

    const messages = processor.port.postMessage.mock.calls.map(
      ([message]) => message as PostedFrame,
    );
    const level = messages.find((message) => message.type === "level") as
      | { type: string; level: number }
      | undefined;
    expect(postedFrames(processor)).toHaveLength(0);
    expect(level?.level).toBeGreaterThan(0.4);
    expect(level?.level).toBeLessThanOrEqual(0.5);
  });

  it("resamples a 48 kHz device signal down to 16 kHz frames", () => {
    const processor = createProcessor() as ProcessorInstance;
    processor.port.onmessage({
      data: { type: "start", credits: 1, maxCredits: 1, sampleRate: 48_000 },
    });

    // 48k 下 100 ms 是 4800 个输入样本，压到 16k 后应是一个 1600 样本帧。
    feedSamples(processor, 4_800);

    const [frame] = postedFrames(processor);
    expect(frame).toMatchObject({ type: "frame", sequence: 0, startSample: 0 });
    expect(frame?.pcm?.byteLength).toBe(3_200);
  });

  it("keeps fractional ratios close to 16 kHz for 44.1 kHz devices", () => {
    const processor = createProcessor() as ProcessorInstance;
    processor.port.onmessage({
      data: { type: "start", credits: 10, maxCredits: 10, sampleRate: 44_100 },
    });

    // 44.1k 下 1000 ms 是 44100 个样本，重采样后应接近 1600*10 个 16k 样本。
    feedSamples(processor, 44_100);
    // 尾帧不足 1600 样本，真实停止时会由 stop 触发 flush，这里补上同样的收口。
    processor.port.onmessage({ data: { type: "stop" } });

    const samples = postedFrames(processor).reduce(
      (total, frame) => total + (frame.pcm?.byteLength ?? 0) / 2,
      0,
    );
    expect(samples).toBeGreaterThan(15_800);
    expect(samples).toBeLessThan(16_200);
  });

  it("bounds queued frames by credits and preserves gaps after dropping audio", () => {
    const processor = createProcessor() as ProcessorInstance;
    processor.port.onmessage({ data: { type: "start", credits: 1, maxCredits: 1 } });

    feedSamples(processor, 3_200);
    expect(postedFrames(processor)).toHaveLength(1);
    expect(postedFrames(processor)[0]).toMatchObject({
      type: "frame",
      sequence: 0,
      startSample: 0,
    });

    processor.port.onmessage({ data: { type: "credit", count: 1 } });
    feedSamples(processor, 1_600);
    expect(postedFrames(processor).at(-1)).toMatchObject({
      type: "frame",
      sequence: 2,
      startSample: 3_200,
    });
  });
});
