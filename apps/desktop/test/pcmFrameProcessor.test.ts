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

function feedSamples(processor: ProcessorInstance, sampleCount: number): void {
  for (let offset = 0; offset < sampleCount; offset += 128) {
    const length = Math.min(128, sampleCount - offset);
    processor.process([[new Float32Array(length).fill(0.25)]], [[new Float32Array(length)]]);
  }
}

describe("PCM AudioWorklet processor", () => {
  it("bounds queued frames by credits and preserves gaps after dropping audio", () => {
    const processor = createProcessor() as ProcessorInstance;
    processor.port.onmessage({ data: { type: "start", credits: 1, maxCredits: 1 } });

    feedSamples(processor, 3_200);
    const frames = processor.port.postMessage.mock.calls.map(([message]) => message);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "frame", sequence: 0, startSample: 0 });

    processor.port.onmessage({ data: { type: "credit", count: 1 } });
    feedSamples(processor, 1_600);
    const resumedFrames = processor.port.postMessage.mock.calls.map(([message]) => message);
    expect(resumedFrames.at(-1)).toMatchObject({
      type: "frame",
      sequence: 2,
      startSample: 3_200,
    });
  });
});
