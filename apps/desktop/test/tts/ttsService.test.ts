import type { ClientTtsConfig } from "@answra/config";
import type { TtsAudioFrame, TtsFailureEvent, TtsStopPayload } from "@answra/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TtsService } from "../../src/main/tts/ttsService";

const PROVIDER = {
  id: "minimax",
  label: "MiniMax",
  protocol: "minimax-native" as const,
  baseUrl: "https://api.minimax.io",
  model: "speech-2.8-turbo",
  voice: "voice-1",
};

function createConfig(overrides: Partial<ClientTtsConfig> = {}): ClientTtsConfig {
  return {
    provider: PROVIDER,
    ...overrides,
  };
}

function createService(options: { config?: ClientTtsConfig; apiKey?: string | null } = {}) {
  const audio: TtsAudioFrame[] = [];
  const failures: TtsFailureEvent[] = [];
  const stopped: TtsStopPayload[] = [];
  const service = new TtsService({
    settings: {
      read: () => options.config ?? createConfig(),
      readApiKey: async () => (options.apiKey === undefined ? "test-key" : options.apiKey),
    },
    emit: {
      audio: (frame) => audio.push(frame),
      failed: (event) => failures.push(event),
      stopped: (payload) => stopped.push(payload),
    },
  });
  return { service, audio, failures, stopped };
}

function stubMinimaxAudio(hex = "00ff") {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ data: { audio: hex }, base_resp: { status_code: 0 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubChatAudio(base64 = "SUQz") {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ choices: [{ message: { audio: { data: base64 } } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function drain(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TtsService", () => {
  it("turns a rehearsal intent into auto audio frames", async () => {
    const fetchMock = stubMinimaxAudio("00ff");
    const { service, audio } = createService();

    await service.handleIntent({
      conversationId: "conversation-1",
      messageId: "message-1",
      sequence: 0,
      delta: "你好，请先自我介绍。",
      final: true,
    });

    await vi.waitFor(() => expect(audio).toHaveLength(1));
    expect(audio[0]).toMatchObject({
      messageId: "message-1",
      conversationId: "conversation-1",
      source: "auto",
      sequence: 0,
      mimeType: "audio/mpeg",
    });
    expect(Array.from(audio[0]?.bytes ?? [])).toEqual([0x00, 0xff]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("stays silent when no provider is saved", async () => {
    const fetchMock = stubMinimaxAudio();
    const { service, audio, failures } = createService({
      config: createConfig({ provider: null }),
    });

    await service.handleIntent({
      conversationId: "conversation-1",
      messageId: "message-1",
      sequence: 0,
      delta: "不应朗读。",
      final: true,
    });
    await drain();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(audio).toHaveLength(0);
    expect(failures).toHaveLength(0);
  });

  it("reports not-configured when no key is stored", async () => {
    const fetchMock = stubMinimaxAudio();
    const { service, failures } = createService({ apiKey: null });

    await service.handleIntent({
      conversationId: "conversation-1",
      messageId: "message-1",
      sequence: 0,
      delta: "你好。",
      final: true,
    });

    expect(failures).toHaveLength(1);
    expect(failures[0]?.failure).toMatchObject({ code: "not-configured", retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports not-configured when no provider is saved but the user asks to read", async () => {
    const { service, failures } = createService({ config: createConfig({ provider: null }) });

    await expect(service.speak({ messageId: "message-1", text: "你好。" })).resolves.toEqual({
      accepted: false,
    });

    expect(failures[0]?.failure.code).toBe("not-configured");
  });

  it("aborts in-flight synthesis and broadcasts stop", async () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetchMock);
    const { service, audio, stopped } = createService();

    await service.handleIntent({
      conversationId: "conversation-1",
      messageId: "message-1",
      sequence: 0,
      delta: "这一条会在合成途中被打断。",
      final: true,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    service.stop({ conversationId: "conversation-1" });
    await drain();

    expect(stopped).toEqual([{ conversationId: "conversation-1" }]);
    expect(audio).toHaveLength(0);
  });

  it("reads a manual request once with the whole-text strategy", async () => {
    const fetchMock = stubMinimaxAudio("aa");
    const { service, audio } = createService();

    await expect(
      service.speak({ messageId: "message-2", text: "第一句。第二句。" }),
    ).resolves.toEqual({ accepted: true });
    await vi.waitFor(() => expect(audio).toHaveLength(1));

    expect(audio[0]).toMatchObject({
      messageId: "message-2",
      conversationId: null,
      source: "manual",
      sequence: 0,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
    );
    expect(body.text).toBe("第一句。第二句。");
  });

  it("uses the configured provider", async () => {
    const fetchMock = stubChatAudio();
    const { service, audio } = createService({
      config: createConfig({
        provider: {
          id: "mimo",
          label: "MiMo",
          protocol: "chat-audio",
          baseUrl: "https://api.xiaomimimo.com/v1",
          model: "mimo-v2.5-tts",
          voice: "mimo_default",
        },
      }),
    });

    await service.handleIntent({
      conversationId: "conversation-1",
      messageId: "message-1",
      sequence: 0,
      delta: "你好。",
      final: true,
    });
    await vi.waitFor(() => expect(audio).toHaveLength(1));

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.xiaomimimo.com/v1/chat/completions");
    const body = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
    );
    expect(body).toMatchObject({
      model: "mimo-v2.5-tts",
      messages: [{ role: "assistant" }],
      audio: { voice: "mimo_default" },
    });
  });

  it("drops queued audio when a new manual request starts", async () => {
    stubMinimaxAudio();
    const { service, stopped } = createService();

    await service.speak({ messageId: "message-1", text: "第一条。" });
    await service.speak({ messageId: "message-2", text: "第二条。" });

    expect(stopped.at(-1)).toEqual({ conversationId: null });
  });
});
