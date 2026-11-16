import type { ConversationModelConfig } from "@answra/shared";
import { describe, expect, it } from "vitest";
import { withLocalProviderProfiles } from "../../src/adapters/localProviderProfiles";
import type { ModelSettings } from "../../src/model/ports";

function settingsFor(config: ConversationModelConfig): ModelSettings {
  return {
    resolve: async () => config,
    addLocal: async () => config,
    switchChatModel: async () => config,
    snapshot: async () => ({
      source: "local",
      local: { baseUrl: "", chatModel: "" },
      configured: false,
    }),
    clearLocal: async () => {},
  };
}

function configFor(baseUrl: string): ConversationModelConfig {
  return {
    chat: { baseUrl, model: "deepseek-v4.1-flash", auth: "local" },
    answer: { baseUrl, model: "deepseek-v4.1-flash", auth: "local" },
  };
}

describe("withLocalProviderProfiles", () => {
  it("adds OpenCode Go client and session headers to both model routes", async () => {
    const wrapped = withLocalProviderProfiles(
      settingsFor(configFor("https://opencode.ai/inference/go/openai/v1")),
    );

    const result = await wrapped.resolve([]);

    for (const endpoint of [result.chat, result.answer]) {
      expect(endpoint.headers).toEqual({ "User-Agent": "answra-cli/0.1.0" });
      expect(endpoint.sessionHeader).toBe("x-opencode-session");
    }
  });

  it("keeps PAYG and generic OpenAI-compatible endpoints unchanged", async () => {
    for (const baseUrl of ["https://opencode.ai/inference/openai/v1", "http://127.0.0.1:1234/v1"]) {
      const result = await withLocalProviderProfiles(settingsFor(configFor(baseUrl))).resolve([]);
      expect(result.chat.headers).toBeUndefined();
      expect(result.chat.sessionHeader).toBeUndefined();
    }
  });

  it("preserves explicit endpoint headers and session header", async () => {
    const config = configFor("https://opencode.ai/zen/go/v1");
    config.chat = { ...config.chat, headers: { "X-Custom": "1" }, sessionHeader: "x-session" };
    const result = await withLocalProviderProfiles(settingsFor(config)).resolve([]);

    expect(result.chat.headers).toEqual({ "User-Agent": "answra-cli/0.1.0", "X-Custom": "1" });
    expect(result.chat.sessionHeader).toBe("x-session");
  });
});
