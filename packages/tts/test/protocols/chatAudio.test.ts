import { describe, expect, it } from "vitest";
import { TtsProviderError } from "../../src/errors";
import { createChatAudioProvider } from "../../src/protocols/chatAudio";
import { jsonResponse, recordingFetch } from "../support/recordingFetch";

const OPTIONS = {
  baseUrl: "https://api.xiaomimimo.com/v1/",
  model: "mimo-v2.5-tts",
  apiKey: "test-key",
  voice: "mimo_default",
};

function provider(respond: (call: { url: string; init: RequestInit }) => Response) {
  const recording = recordingFetch(respond);
  return { port: createChatAudioProvider({ ...OPTIONS, fetch: recording.fetch }), recording };
}

function audioResponse(data: string) {
  return jsonResponse({ choices: [{ message: { audio: { data } } }] });
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(TtsProviderError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe("chat-audio", () => {
  it("posts the text as an assistant message and decodes Base64 audio", async () => {
    const { port, recording } = provider(() => audioResponse("SUQz"));

    const result = await port.synthesize({ text: "你好，请先自我介绍。" });

    expect(result.bytes).toEqual(new Uint8Array([0x49, 0x44, 0x33]));
    expect(result.mimeType).toBe("audio/mpeg");
    const call = recording.calls[0];
    if (call === undefined) throw new Error("缺少请求记录");
    expect(call.url).toBe("https://api.xiaomimimo.com/v1/chat/completions");
    expect((call.init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(JSON.parse(String(call.init.body))).toMatchObject({
      model: "mimo-v2.5-tts",
      messages: [{ role: "assistant", content: "你好，请先自我介绍。" }],
      audio: { format: "mp3", voice: "mimo_default" },
      stream: false,
    });
  });

  it("omits the voice so the provider can use its default", async () => {
    const recording = recordingFetch(() => audioResponse("SUQz"));
    const port = createChatAudioProvider({ ...OPTIONS, voice: "", fetch: recording.fetch });

    await port.synthesize({ text: "你好。" });

    const body = JSON.parse(String(recording.calls[0]?.init.body));
    expect(body.audio).toEqual({ format: "mp3" });
  });

  it("rejects a response without choices or audio data", async () => {
    const withoutChoices = provider(() => jsonResponse({}));
    await expectCode(withoutChoices.port.synthesize({ text: "你好。" }), "provider-rejected");

    const withoutAudio = provider(() => jsonResponse({ choices: [{ message: {} }] }));
    await expectCode(withoutAudio.port.synthesize({ text: "你好。" }), "provider-rejected");
  });

  it("reports empty audio and invalid Base64", async () => {
    const empty = provider(() => audioResponse(""));
    await expectCode(empty.port.synthesize({ text: "你好。" }), "empty-audio");

    const illegal = provider(() => audioResponse("!!not-base64!!"));
    await expectCode(illegal.port.synthesize({ text: "你好。" }), "provider-rejected");
  });

  it("maps HTTP status codes", async () => {
    const unauthorized = provider(() => new Response("denied", { status: 401 }));
    await expectCode(unauthorized.port.synthesize({ text: "你好。" }), "unauthorized");

    const limited = provider(() => new Response("slow down", { status: 429 }));
    await expectCode(limited.port.synthesize({ text: "你好。" }), "rate-limited");
  });

  it("rejects empty text without calling the endpoint", async () => {
    const { port, recording } = provider(() => audioResponse("SUQz"));

    await expectCode(port.synthesize({ text: "   " }), "invalid-request");
    expect(recording.calls).toHaveLength(0);
  });

  it("declares non-streaming capabilities", () => {
    const { port } = provider(() => audioResponse("SUQz"));
    expect(port.capabilities).toMatchObject({
      streaming: false,
      formats: ["mp3"],
      voiceCatalog: "static",
    });
  });
});
