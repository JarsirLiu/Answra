import type { TtsProviderCapabilities } from "@answra/shared/tts";
import { describe, expect, it } from "vitest";
import type { TtsProviderPort } from "../../src/port";
import { createWholeTextStrategy } from "../../src/strategies/wholeText";
import type { TtsSegmentAudio } from "../../src/utterance";

const CAPABILITIES: TtsProviderCapabilities = {
  streaming: false,
  formats: ["mp3"],
  maxChars: 1_000,
  supportsSpeed: false,
  supportsEmotion: false,
  voiceCatalog: "none",
};

function createFakePort(): { port: TtsProviderPort; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    port: {
      capabilities: CAPABILITIES,
      async synthesize(request) {
        calls.push(request.text);
        return { bytes: Uint8Array.of(calls.length), mimeType: "audio/mpeg" };
      },
    },
  };
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

describe("createWholeTextStrategy", () => {
  it("waits for the whole text and synthesizes once", async () => {
    const { port, calls } = createFakePort();

    const segments = await collect(
      createWholeTextStrategy().speak(
        { messageId: "m1", text: textFrom(["**你", "好**。"]) },
        { port },
      ),
    );

    expect(calls).toEqual(["你好。"]);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ messageId: "m1", sequence: 0 });
  });

  it("rejects with aborted before reading when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { port, calls } = createFakePort();

    await expect(
      collect(
        createWholeTextStrategy().speak(
          { messageId: "m1", text: textFrom(["你好。"]) },
          { port, signal: controller.signal },
        ),
      ),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(calls).toHaveLength(0);
  });
});
