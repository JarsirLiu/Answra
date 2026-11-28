import { describe, expect, it } from "vitest";
import { TtsProviderError } from "../../src/errors";
import { createOpenAiCompatibleProvider } from "../../src/protocols/openAiCompatible";
import { jsonResponse, recordingFetch } from "../support/recordingFetch";

const OPTIONS = {
  baseUrl: "https://api.openai.com/v1",
  model: "tts-1",
  apiKey: "test-key",
  voice: "alloy",
};

function provider(respond: (call: { url: string; init: RequestInit }) => Response) {
  const recording = recordingFetch(respond);
  return {
    port: createOpenAiCompatibleProvider({ ...OPTIONS, fetch: recording.fetch }),
    recording,
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(TtsProviderError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe("openai-compatible", () => {
  it("posts to /audio/speech and returns binary audio", async () => {
    const { port, recording } = provider(
      () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "Content-Type": "audio/mpeg" },
        }),
    );

    const result = await port.synthesize({ text: "Hello." });

    expect(result.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(result.mimeType).toBe("audio/mpeg");
    const call = recording.calls[0];
    expect(call?.url).toBe("https://api.openai.com/v1/audio/speech");
    expect(JSON.parse(String(call?.init.body))).toEqual({
      model: "tts-1",
      input: "Hello.",
      voice: "alloy",
      response_format: "mp3",
    });
  });

  it("passes provider speed when configured", async () => {
    const recording = recordingFetch(
      () => new Response(new Uint8Array([1]), { headers: { "Content-Type": "audio/mpeg" } }),
    );
    const port = createOpenAiCompatibleProvider({
      ...OPTIONS,
      options: { speed: 1.2 },
      fetch: recording.fetch,
    });

    await port.synthesize({ text: "Hello." });

    expect(JSON.parse(String(recording.calls[0]?.init.body))).toMatchObject({ speed: 1.2 });
  });

  it("rejects a non-audio response even on HTTP 200", async () => {
    const { port } = provider(() => jsonResponse({ error: "quota" }));

    await expectCode(port.synthesize({ text: "Hello." }), "provider-rejected");
  });

  it("reports empty audio", async () => {
    const { port } = provider(
      () => new Response(new Uint8Array(0), { headers: { "Content-Type": "audio/mpeg" } }),
    );

    await expectCode(port.synthesize({ text: "Hello." }), "empty-audio");
  });

  it("requires a voice and non-empty text", async () => {
    const recording = recordingFetch(() => jsonResponse({}));
    const withoutVoice = createOpenAiCompatibleProvider({
      ...OPTIONS,
      voice: "",
      fetch: recording.fetch,
    });
    const withVoice = createOpenAiCompatibleProvider({ ...OPTIONS, fetch: recording.fetch });

    await expectCode(withoutVoice.synthesize({ text: "Hello." }), "not-configured");
    await expectCode(withVoice.synthesize({ text: "" }), "invalid-request");
    expect(recording.calls).toHaveLength(0);
  });

  it("maps HTTP status codes", async () => {
    const unauthorized = provider(() => new Response("denied", { status: 403 }));
    await expectCode(unauthorized.port.synthesize({ text: "Hello." }), "unauthorized");

    const limited = provider(() => new Response("slow down", { status: 429 }));
    await expectCode(limited.port.synthesize({ text: "Hello." }), "rate-limited");

    const broken = provider(() => new Response("boom", { status: 503 }));
    await expectCode(broken.port.synthesize({ text: "Hello." }), "network");
  });

  it("declares capabilities", () => {
    const { port } = provider(() => jsonResponse({}));
    expect(port.capabilities).toMatchObject({
      streaming: false,
      formats: ["mp3"],
      supportsSpeed: true,
      voiceCatalog: "static",
    });
  });
});
