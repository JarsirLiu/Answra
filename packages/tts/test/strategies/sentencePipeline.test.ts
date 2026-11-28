import type { TtsProviderCapabilities } from "@answra/shared/tts";
import { describe, expect, it } from "vitest";
import { TtsProviderError } from "../../src/errors";
import type { TtsProviderPort } from "../../src/port";
import { createSentencePipelineStrategy } from "../../src/strategies/sentencePipeline";
import type { TtsSegmentAudio } from "../../src/utterance";

const CAPABILITIES: TtsProviderCapabilities = {
  streaming: false,
  formats: ["mp3"],
  maxChars: 1_000,
  supportsSpeed: false,
  supportsEmotion: false,
  voiceCatalog: "none",
};

function createFakePort(delayFor: (index: number) => number) {
  const calls: string[] = [];
  let index = 0;
  const port: TtsProviderPort = {
    capabilities: CAPABILITIES,
    async synthesize(request) {
      const current = index;
      index += 1;
      calls.push(request.text);
      const delay = delayFor(current);
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      return { bytes: Uint8Array.of(current), mimeType: "audio/mpeg" };
    },
  };
  return { port, calls };
}

async function* textFrom(parts: readonly string[]): AsyncGenerator<string> {
  for (const part of parts) yield part;
}

async function collect(
  stream: AsyncIterable<TtsSegmentAudio>,
): Promise<readonly TtsSegmentAudio[]> {
  const segments: TtsSegmentAudio[] = [];
  for await (const segment of stream) segments.push(segment);
  return segments;
}

describe("createSentencePipelineStrategy", () => {
  it("yields segments in sequence order even when later synthesis finishes first", async () => {
    const { port, calls } = createFakePort((index) => [40, 10, 0][index] ?? 0);
    const strategy = createSentencePipelineStrategy({ concurrency: 3 });

    const segments = await collect(
      strategy.speak({ messageId: "m1", text: textFrom(["第一句。第二句。第三句。"]) }, { port }),
    );

    expect(segments.map((segment) => segment.sequence)).toEqual([0, 1, 2]);
    expect(segments.map((segment) => segment.messageId)).toEqual(["m1", "m1", "m1"]);
    expect(calls).toEqual(["第一句。", "第二句。", "第三句。"]);
  });

  it("starts the first synthesis before the text stream finishes", async () => {
    const began = Date.now();
    let textFinishedAt = Number.POSITIVE_INFINITY;
    let firstSegmentAt = Number.POSITIVE_INFINITY;

    async function* slowText(): AsyncGenerator<string> {
      yield "第一句。";
      await new Promise((resolve) => setTimeout(resolve, 50));
      textFinishedAt = Date.now() - began;
      yield "第二句。";
    }

    const { port } = createFakePort(() => 0);
    const strategy = createSentencePipelineStrategy();
    let seen = 0;
    for await (const segment of strategy.speak({ messageId: "m1", text: slowText() }, { port })) {
      if (seen === 0) expect(segment.sequence).toBe(0);
      seen += 1;
      firstSegmentAt = Math.min(firstSegmentAt, Date.now() - began);
    }

    expect(seen).toBe(2);
    expect(firstSegmentAt).toBeLessThan(textFinishedAt);
  });

  it("stops without synthesizing when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { port, calls } = createFakePort(() => 0);
    const strategy = createSentencePipelineStrategy();

    await expect(
      collect(
        strategy.speak(
          { messageId: "m1", text: textFrom(["第一句。"]) },
          { port, signal: controller.signal },
        ),
      ),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(calls).toHaveLength(0);
  });

  it("sanitizes markdown before synthesis", async () => {
    const { port, calls } = createFakePort(() => 0);
    const strategy = createSentencePipelineStrategy();

    await collect(
      strategy.speak(
        { messageId: "m1", text: textFrom(["请看[这里](https://example.com)。"]) },
        { port },
      ),
    );

    expect(calls).toEqual(["请看这里。"]);
  });

  it("emits sanitized tail after the text stream ends", async () => {
    const { port, calls } = createFakePort(() => 0);
    const strategy = createSentencePipelineStrategy();

    await collect(strategy.speak({ messageId: "m1", text: textFrom(["看[这里]"]) }, { port }));

    expect(calls).toEqual(["看这里"]);
  });

  it("propagates the original provider failure instead of reporting abort", async () => {
    const port: TtsProviderPort = {
      capabilities: CAPABILITIES,
      async synthesize() {
        throw new TtsProviderError("network", "无法连接 TTS 服务。");
      },
    };
    const strategy = createSentencePipelineStrategy();

    await expect(
      collect(strategy.speak({ messageId: "m1", text: textFrom(["第一句。"]) }, { port })),
    ).rejects.toMatchObject({ code: "network" });
  });
});
