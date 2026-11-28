import { describe, expect, it } from "vitest";
import { parseClientConfig } from "../../src/store";
import { defaultClientTtsConfig, parseClientTtsConfig } from "../../src/tts";

const BASE_CONFIG = {
  version: 1,
  model: { source: "cloud", local: { baseUrl: "", chatModel: "" } },
};

function provider(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "minimax",
    label: "MiniMax",
    protocol: "minimax-native",
    baseUrl: "https://api.minimax.io/",
    model: "speech-2.8-turbo",
    voice: "voice-1",
    ...overrides,
  };
}

describe("parseClientTtsConfig", () => {
  it("returns undefined when the section is absent", () => {
    expect(parseClientTtsConfig(undefined)).toBeUndefined();
    expect(parseClientTtsConfig(null)).toBeUndefined();
  });

  it("defaults to no provider", () => {
    expect(defaultClientTtsConfig()).toEqual({ provider: null });
  });

  it("normalizes the single provider", () => {
    const config = parseClientTtsConfig({ enabled: true, provider: provider() });

    expect(config).toEqual({
      provider: {
        id: "minimax",
        label: "MiniMax",
        protocol: "minimax-native",
        baseUrl: "https://api.minimax.io",
        model: "speech-2.8-turbo",
        voice: "voice-1",
      },
    });
  });

  it("migrates the legacy provider list by preferring the active id", () => {
    const config = parseClientTtsConfig({
      enabled: true,
      strategy: "whole-text",
      activeProviderId: "mimo",
      providers: [
        provider(),
        provider({ id: "mimo", label: "MiMo", protocol: "chat-audio", voice: "mimo_default" }),
      ],
    });

    expect(config).toEqual({
      provider: expect.objectContaining({ id: "mimo", protocol: "chat-audio" }),
    });
  });

  it("falls back to the first legacy provider when the active id is missing", () => {
    const config = parseClientTtsConfig({
      activeProviderId: "removed",
      providers: [provider()],
    });

    expect(config?.provider?.id).toBe("minimax");
  });

  it("treats an explicit null provider as cleared even with legacy fields", () => {
    const config = parseClientTtsConfig({
      provider: null,
      providers: [provider()],
      activeProviderId: "minimax",
    });

    expect(config?.provider).toBeNull();
  });

  it("rejects unsafe provider ids", () => {
    expect(() => parseClientTtsConfig({ provider: provider({ id: "MiniMax" }) })).toThrowError(
      /只允许小写字母/,
    );
    expect(() => parseClientTtsConfig({ provider: provider({ id: "a:b" }) })).toThrowError(
      /只允许小写字母/,
    );
  });

  it("rejects unknown protocols and invalid urls", () => {
    expect(() =>
      parseClientTtsConfig({ provider: provider({ protocol: "dashscope" }) }),
    ).toThrowError(/protocol 不受支持/);
    expect(() =>
      parseClientTtsConfig({ provider: provider({ baseUrl: "ftp://example.com" }) }),
    ).toThrowError(/只支持 http/);
  });
});

describe("ClientConfig integration", () => {
  it("keeps the tts section through parseClientConfig", () => {
    const parsed = parseClientConfig({
      ...BASE_CONFIG,
      tts: { enabled: true, provider: provider() },
    });

    expect(parsed.tts?.provider?.baseUrl).toBe("https://api.minimax.io");
  });

  it("omits the section when absent", () => {
    expect(parseClientConfig(BASE_CONFIG).tts).toBeUndefined();
  });
});
