import { TTS_PROVIDER_CATALOG, type TtsProviderConfig } from "@answra/shared";
import { describe, expect, it } from "vitest";
import {
  applyPreset,
  blankProviderForm,
  CUSTOM_PROVIDER_ID,
  draftOfForm,
  formOfProvider,
  matchPresetId,
  selectCustom,
  selectProtocol,
} from "../../src/tts/providerDraft";

function preset(id: string) {
  const found = TTS_PROVIDER_CATALOG.find((item) => item.id === id);
  if (found === undefined) throw new Error(`目录缺少 ${id}`);
  return found;
}

function provider(overrides: Partial<TtsProviderConfig> = {}): TtsProviderConfig {
  return {
    id: "minimax",
    label: "MiniMax",
    protocol: "minimax-native",
    baseUrl: "https://api.minimax.io",
    model: "speech-2.8-turbo",
    voice: "voice-1",
    hasApiKey: true,
    capabilities: {
      streaming: false,
      formats: ["mp3"],
      maxChars: 1_000,
      supportsSpeed: false,
      supportsEmotion: false,
      voiceCatalog: "remote",
    },
    ...overrides,
  };
}

describe("providerDraft", () => {
  it("starts the form from the first catalog entry", () => {
    const form = blankProviderForm();
    const first = preset("minimax");

    expect(form).toMatchObject({
      id: first.id,
      label: first.label,
      protocol: first.protocol,
      baseUrl: first.baseUrl,
      model: first.model,
      voice: first.voice,
      apiKey: "",
      presetId: first.id,
    });
  });

  it("applies a preset over every field and clears a typed key", () => {
    const form = applyPreset(preset("mimo"));

    expect(form.protocol).toBe("chat-audio");
    expect(form.baseUrl).toBe(preset("mimo").baseUrl);
    expect(form.model).toBe(preset("mimo").model);
    expect(form.voice).toBe(preset("mimo").voice);
    expect(form.label).toBe("MiMo");
    expect(form.apiKey).toBe("");
    expect(form.presetId).toBe("mimo");
  });

  it("keeps the current form, including a custom id, when the same vendor is re-applied", () => {
    const customized = {
      ...formOfProvider(provider({ id: "my-minimax" })),
      model: "custom-model",
      voice: "custom-voice",
    };

    expect(applyPreset(preset("minimax"), customized)).toBe(customized);
  });

  it("switches to custom without losing the current endpoint", () => {
    const customized = selectCustom({
      ...applyPreset(preset("mimo")),
      apiKey: "sk-1",
      baseUrl: "https://api.example.com/v1",
    });

    expect(customized).toMatchObject({
      id: CUSTOM_PROVIDER_ID,
      label: "自定义",
      baseUrl: "https://api.example.com/v1",
      apiKey: "",
      presetId: null,
    });
    expect(selectCustom(customized)).toBe(customized);
  });

  it("switches protocol in custom mode without overwriting hand-edited fields", () => {
    const customized = {
      ...applyPreset(preset("minimax")),
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-1",
      presetId: null,
    };

    const next = selectProtocol(customized, "openai-compatible");

    expect(next.protocol).toBe("openai-compatible");
    expect(next.baseUrl).toBe("https://api.example.com/v1");
    expect(next.model).toBe(preset("openai").model);
    expect(next.voice).toBe(preset("openai").voice);
    expect(next.presetId).toBeNull();
    expect(next.apiKey).toBe("sk-1");
  });

  it("recognizes a saved provider that still matches a catalog entry", () => {
    const matched = provider({ ...preset("mimo") });
    expect(matchPresetId(matched)).toBe("mimo");
    expect(matchPresetId(provider({ voice: "my-cloned-voice" }))).toBe("minimax");

    const edited = provider({ model: "custom-model" });
    expect(matchPresetId(edited)).toBeNull();
    expect(formOfProvider(edited)).toMatchObject({ id: "minimax", apiKey: "", presetId: null });
  });

  it("sends concrete values only, never the catalog id", () => {
    const draft = draftOfForm({
      id: " mimo ",
      label: " MiMo ",
      protocol: "chat-audio",
      baseUrl: " https://api.xiaomimimo.com/v1 ",
      model: " mimo-v2.5-tts ",
      voice: " mimo_default ",
      apiKey: "  ",
      presetId: "mimo",
    });

    expect(draft).toEqual({
      id: "mimo",
      label: "MiMo",
      protocol: "chat-audio",
      baseUrl: "https://api.xiaomimimo.com/v1",
      model: "mimo-v2.5-tts",
      voice: "mimo_default",
    });
    expect(draftOfForm({ ...blankProviderForm(), apiKey: " sk-2 " })).toMatchObject({
      id: "minimax",
      apiKey: "sk-2",
    });
  });
});
