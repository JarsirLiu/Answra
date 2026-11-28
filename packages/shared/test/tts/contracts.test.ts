import { describe, expect, it } from "vitest";
import {
  isRetryableTtsErrorCode,
  isTtsErrorCode,
  isTtsProtocol,
  isTtsProviderId,
  TTS_ERROR_CODES,
  TTS_PROTOCOL_PRESETS,
  TTS_PROTOCOLS,
} from "../../src/tts";

describe("tts contracts", () => {
  it("exposes a preset for every protocol", () => {
    expect(Object.keys(TTS_PROTOCOL_PRESETS).sort()).toEqual([...TTS_PROTOCOLS].sort());
    for (const protocol of TTS_PROTOCOLS) {
      const preset = TTS_PROTOCOL_PRESETS[protocol];
      expect(preset.protocol).toBe(protocol);
      expect(preset.baseUrl).toMatch(/^https?:\/\//);
      expect(preset.model).not.toBe("");
    }
  });

  it("only marks transient failures as retryable", () => {
    const retryable = TTS_ERROR_CODES.filter(isRetryableTtsErrorCode);
    expect(retryable).toEqual(["rate-limited", "network", "timeout"]);
  });

  it("validates provider ids used as keychain accounts", () => {
    expect(isTtsProviderId("minimax")).toBe(true);
    expect(isTtsProviderId("custom-1")).toBe(true);
    expect(isTtsProviderId("Minimax")).toBe(false);
    expect(isTtsProviderId("a:b")).toBe(false);
    expect(isTtsProviderId("")).toBe(false);
    expect(isTtsProviderId("a".repeat(33))).toBe(false);
  });

  it("validates protocols and error codes", () => {
    expect(isTtsProtocol("minimax-native")).toBe(true);
    expect(isTtsProtocol("chat-audio")).toBe(true);
    expect(isTtsProtocol("dashscope")).toBe(false);
    expect(isTtsErrorCode("aborted")).toBe(true);
    expect(isTtsErrorCode("failed")).toBe(false);
  });
});
