import { describe, expect, it } from "vitest";
import {
  findTtsProviderPreset,
  isTtsProviderId,
  TTS_PROTOCOL_PRESETS,
  TTS_PROTOCOLS,
  TTS_PROVIDER_CATALOG,
} from "../../src/tts";

describe("tts provider catalog", () => {
  it("has a valid, unique id for every entry", () => {
    const ids = TTS_PROVIDER_CATALOG.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of TTS_PROVIDER_CATALOG) {
      expect(isTtsProviderId(preset.id)).toBe(true);
      expect(preset.label).not.toBe("");
      expect(preset.baseUrl).toMatch(/^https?:\/\//);
      expect(preset.apiKeyUrl).toMatch(/^https:\/\//);
      expect(preset.model).not.toBe("");
    }
  });

  it("covers every protocol with a known catalog entry", () => {
    for (const protocol of TTS_PROTOCOLS) {
      const entries = TTS_PROVIDER_CATALOG.filter((preset) => preset.protocol === protocol);
      expect(entries.length).toBeGreaterThan(0);
    }
  });

  it("derives each protocol preset from the first catalog entry of that protocol", () => {
    for (const protocol of TTS_PROTOCOLS) {
      const first = TTS_PROVIDER_CATALOG.find((preset) => preset.protocol === protocol);
      expect(TTS_PROTOCOL_PRESETS[protocol]).toEqual({
        protocol,
        label: first?.label,
        baseUrl: first?.baseUrl,
        model: first?.model,
        voice: first?.voice,
      });
    }
  });

  it("looks presets up by catalog id without guessing", () => {
    expect(findTtsProviderPreset("mimo")?.protocol).toBe("chat-audio");
    expect(findTtsProviderPreset("unknown")).toBeUndefined();
  });
});
