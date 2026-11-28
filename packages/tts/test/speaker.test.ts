import type { TtsProtocol, TtsStrategyId } from "@answra/shared/tts";
import { describe, expect, it } from "vitest";
import { TtsProviderError } from "../src/errors";
import { createTtsSpeaker } from "../src/speaker";
import type { TtsSegmentAudio } from "../src/utterance";
import { jsonResponse, recordingFetch } from "./support/recordingFetch";

const OPTIONS = {
  baseUrl: "https://api.minimax.io",
  model: "speech-2.8-turbo",
  apiKey: "test-key",
  voice: "voice-1",
};

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

function minimaxFetch() {
  let call = 0;
  return recordingFetch(() => {
    call += 1;
    return jsonResponse({
      data: { audio: call.toString(16).padStart(2, "0") },
      base_resp: { status_code: 0 },
    });
  });
}

describe("createTtsSpeaker", () => {
  it("fails explicitly on an unknown protocol", () => {
    const recording = minimaxFetch();

    expect(() =>
      createTtsSpeaker("dashscope" as TtsProtocol, { ...OPTIONS, fetch: recording.fetch }),
    ).toThrowError(TtsProviderError);
    expect(() =>
      createTtsSpeaker("dashscope" as TtsProtocol, { ...OPTIONS, fetch: recording.fetch }),
    ).toThrowError(/不支持的 TTS 协议/);
  });

  it("fails explicitly on an unknown strategy", () => {
    const recording = minimaxFetch();

    expect(() =>
      createTtsSpeaker(
        "minimax-native",
        { ...OPTIONS, fetch: recording.fetch },
        {
          strategy: "streaming-audio" as TtsStrategyId,
        },
      ),
    ).toThrowError(/不支持的 TTS 策略/);
  });

  it("synthesizes split segments in order with increasing sequence", async () => {
    const recording = minimaxFetch();
    const speaker = createTtsSpeaker("minimax-native", { ...OPTIONS, fetch: recording.fetch });

    const text = "这是一句用于测试切分的中文句子。".repeat(80);
    const segments = await collect(speaker.speak({ messageId: "m1", text: textFrom([text]) }));

    expect(recording.calls.length).toBeGreaterThan(1);
    expect(segments).toHaveLength(recording.calls.length);
    expect(segments.map((segment) => segment.sequence)).toEqual(
      recording.calls.map((_call, index) => index),
    );
    expect(segments.map((segment) => segment.bytes[0])).toEqual(
      recording.calls.map((_call, index) => index + 1),
    );
  });

  it("lets a single call override the speaker strategy", async () => {
    const recording = minimaxFetch();
    const speaker = createTtsSpeaker(
      "minimax-native",
      { ...OPTIONS, fetch: recording.fetch },
      { strategy: "sentence-pipeline" },
    );

    const segments = await collect(
      speaker.speak(
        { messageId: "m1", text: textFrom(["第一句。第二句。"]) },
        { strategy: "whole-text" },
      ),
    );

    expect(segments.map((segment) => segment.sequence)).toEqual([0]);
    expect(recording.calls).toHaveLength(1);
  });

  it("stops before the next segment when aborted", async () => {
    const recording = minimaxFetch();
    const speaker = createTtsSpeaker("minimax-native", { ...OPTIONS, fetch: recording.fetch });
    const controller = new AbortController();
    controller.abort();

    await expect(
      collect(
        speaker.speak(
          { messageId: "m1", text: textFrom(["这是一句用于测试切分的中文句子。".repeat(80)]) },
          { signal: controller.signal },
        ),
      ),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(recording.calls).toHaveLength(0);
  });
});
