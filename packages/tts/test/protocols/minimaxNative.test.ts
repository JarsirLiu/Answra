import { describe, expect, it } from "vitest";
import { TtsProviderError } from "../../src/errors";
import { createMinimaxNativeProvider } from "../../src/protocols/minimaxNative";
import { jsonResponse, recordingFetch } from "../support/recordingFetch";

const OPTIONS = {
  baseUrl: "https://api.minimax.io/",
  model: "speech-2.8-turbo",
  apiKey: "test-key",
  voice: "Chinese (Mandarin)_Warm_Girl",
};

function provider(respond: (call: { url: string; init: RequestInit }) => Response) {
  const recording = recordingFetch(respond);
  return { port: createMinimaxNativeProvider({ ...OPTIONS, fetch: recording.fetch }), recording };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(TtsProviderError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe("minimax-native", () => {
  it("posts to /v1/t2a_v2 and decodes hex audio", async () => {
    const { port, recording } = provider(() =>
      jsonResponse({ data: { audio: "494433" }, base_resp: { status_code: 0 } }),
    );

    const result = await port.synthesize({ text: "你好。" });

    expect(result.bytes).toEqual(new Uint8Array([0x49, 0x44, 0x33]));
    expect(result.mimeType).toBe("audio/mpeg");
    expect(recording.calls).toHaveLength(1);
    const call = recording.calls[0];
    if (call === undefined) throw new Error("缺少请求记录");
    expect(call.url).toBe("https://api.minimax.io/v1/t2a_v2");
    expect((call.init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(JSON.parse(String(call.init.body))).toMatchObject({
      model: "speech-2.8-turbo",
      text: "你好。",
      stream: false,
      voice_setting: { voice_id: "Chinese (Mandarin)_Warm_Girl" },
      audio_setting: { format: "mp3", sample_rate: 32_000, bitrate: 128_000, channel: 1 },
    });
  });

  it("treats non-zero base_resp as provider-rejected even on HTTP 200", async () => {
    const { port } = provider(() =>
      jsonResponse({ base_resp: { status_code: 1004, status_msg: "invalid api key" } }),
    );

    await expectCode(port.synthesize({ text: "你好。" }), "provider-rejected");
  });

  it("reports empty audio", async () => {
    const { port } = provider(() =>
      jsonResponse({ data: { audio: "" }, base_resp: { status_code: 0 } }),
    );

    await expectCode(port.synthesize({ text: "你好。" }), "empty-audio");
  });

  it("rejects malformed hex", async () => {
    const odd = provider(() =>
      jsonResponse({ data: { audio: "abc" }, base_resp: { status_code: 0 } }),
    );
    await expectCode(odd.port.synthesize({ text: "你好。" }), "provider-rejected");

    const illegal = provider(() =>
      jsonResponse({ data: { audio: "zz" }, base_resp: { status_code: 0 } }),
    );
    await expectCode(illegal.port.synthesize({ text: "你好。" }), "provider-rejected");
  });

  it("rejects a missing data.audio", async () => {
    const { port } = provider(() => jsonResponse({ base_resp: { status_code: 0 } }));

    await expectCode(port.synthesize({ text: "你好。" }), "provider-rejected");
  });

  it("maps HTTP status codes", async () => {
    const unauthorized = provider(() => new Response("denied", { status: 401 }));
    await expectCode(unauthorized.port.synthesize({ text: "你好。" }), "unauthorized");

    const limited = provider(() => new Response("slow down", { status: 429 }));
    await expectCode(limited.port.synthesize({ text: "你好。" }), "rate-limited");
  });

  it("requires a voice and non-empty text", async () => {
    const recording = recordingFetch(() => jsonResponse({}));
    const withoutVoice = createMinimaxNativeProvider({
      ...OPTIONS,
      voice: "",
      fetch: recording.fetch,
    });
    const withVoice = createMinimaxNativeProvider({ ...OPTIONS, fetch: recording.fetch });

    await expectCode(withoutVoice.synthesize({ text: "你好。" }), "not-configured");
    await expectCode(withVoice.synthesize({ text: "   " }), "invalid-request");
    expect(recording.calls).toHaveLength(0);
  });

  it("declares conservative capabilities", () => {
    const { port } = provider(() => jsonResponse({}));
    expect(port.capabilities).toMatchObject({
      streaming: false,
      formats: ["mp3"],
      voiceCatalog: "remote",
    });
  });
});
