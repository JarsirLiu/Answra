import type { ClientConfig } from "@answra/config";
import { AI_SERVICE_BASE_URL, CLI_MODEL } from "@answra/shared";
import { describe, expect, it } from "vitest";
import type { ModelSettingsStore } from "../../src/model/ports";
import { ModelSettingsService } from "../../src/model/settingsService";

function sharedConfig(overrides: Partial<ClientConfig["model"]["local"]> = {}): ClientConfig {
  return {
    version: 1,
    model: {
      source: "cloud",
      local: {
        baseUrl: "http://127.0.0.1:1234/v1",
        chatModel: "shared-model",
        answerModel: "shared-answer",
        ...overrides,
      },
    },
  };
}

function createSettings(initial: ClientConfig | null = null) {
  let config = initial;
  const store: ModelSettingsStore = {
    read: async () => config,
    write: async (next) => {
      config = next;
    },
  };
  return { settings: new ModelSettingsService(store), read: () => config };
}

function envOverrides(values: Record<string, string | undefined>) {
  return {
    baseUrl: values[AI_SERVICE_BASE_URL],
    chatModel: values[CLI_MODEL],
  };
}

describe("ModelSettingsService.resolve", () => {
  it("maps the same local endpoint to chat and answer", async () => {
    const { settings } = createSettings();
    const model = await settings.resolve([
      { baseUrl: "http://127.0.0.1:1234/v1/", chatModel: " local-model " },
    ]);

    expect(model).toEqual({
      chat: { baseUrl: "http://127.0.0.1:1234/v1", model: "local-model", auth: "local" },
      answer: { baseUrl: "http://127.0.0.1:1234/v1", model: "local-model", auth: "local" },
    });
  });

  it("lets earlier overrides win per field and falls through empty values", async () => {
    const { settings } = createSettings();
    const model = await settings.resolve([
      { baseUrl: "https://example.com/v1" },
      envOverrides({
        [AI_SERVICE_BASE_URL]: "http://ignored:1234/v1",
        [CLI_MODEL]: "env-model",
      }),
    ]);

    expect(model.chat).toEqual({
      baseUrl: "https://example.com/v1",
      model: "env-model",
      auth: "local",
    });
  });

  it("fails explicitly when required values are absent", async () => {
    const { settings } = createSettings();

    await expect(settings.resolve([])).rejects.toThrow(
      `缺少 ${AI_SERVICE_BASE_URL}（共享配置也没有本地模型地址）。`,
    );
    await expect(settings.resolve([{ baseUrl: "http://127.0.0.1:1234/v1" }])).rejects.toThrow(
      `缺少 ${CLI_MODEL}（共享配置也没有本地模型 ID）。`,
    );
  });

  it("uses the shared local model when overrides are absent", async () => {
    const { settings } = createSettings(sharedConfig());

    await expect(settings.resolve([])).resolves.toEqual({
      chat: { baseUrl: "http://127.0.0.1:1234/v1", model: "shared-model", auth: "local" },
      answer: {
        baseUrl: "http://127.0.0.1:1234/v1",
        model: "shared-answer",
        auth: "local",
      },
    });
  });

  it("overrides shared values per field and reuses the model override for answer", async () => {
    const { settings } = createSettings(sharedConfig());
    const model = await settings.resolve([{ chatModel: "option-model" }]);

    expect(model).toEqual({
      chat: { baseUrl: "http://127.0.0.1:1234/v1", model: "option-model", auth: "local" },
      answer: { baseUrl: "http://127.0.0.1:1234/v1", model: "option-model", auth: "local" },
    });
  });

  it("does not invent a local endpoint when nothing is configured", async () => {
    const { settings } = createSettings(
      sharedConfig({ baseUrl: "", chatModel: "", answerModel: undefined }),
    );

    await expect(settings.resolve([])).rejects.toThrow("缺少 ANSWRA_AI_BASE_URL");
  });

  it("rejects malformed, non-http, and credentialed endpoints", async () => {
    const { settings } = createSettings();
    for (const baseUrl of [
      "not-a-url",
      "ftp://example.com/v1",
      "http://user:pass@example.com/v1",
    ]) {
      await expect(settings.resolve([{ baseUrl, chatModel: "m" }])).rejects.toThrow("本地模型地址");
    }
  });
});

describe("ModelSettingsService persistence", () => {
  it("adds a local model, marks the source local, and reports a snapshot", async () => {
    const { settings, read } = createSettings();

    const model = await settings.addLocal({
      baseUrl: "http://127.0.0.1:1234/v1/",
      chatModel: " qwen ",
      answerModel: " qwen-vl ",
    });

    expect(model.chat.model).toBe("qwen");
    expect(read()).toEqual({
      version: 1,
      model: {
        source: "local",
        local: {
          baseUrl: "http://127.0.0.1:1234/v1",
          chatModel: "qwen",
          answerModel: "qwen-vl",
        },
      },
    });
    await expect(settings.snapshot()).resolves.toEqual({
      source: "local",
      local: {
        baseUrl: "http://127.0.0.1:1234/v1",
        chatModel: "qwen",
        answerModel: "qwen-vl",
      },
      configured: true,
    });
  });

  it("switches the chat model while preserving the endpoint and answer model", async () => {
    const { settings, read } = createSettings(sharedConfig());

    await settings.switchChatModel(" next ");

    expect(read()).toEqual({
      version: 1,
      model: {
        source: "local",
        local: {
          baseUrl: "http://127.0.0.1:1234/v1",
          chatModel: "next",
          answerModel: "shared-answer",
        },
      },
    });
  });

  it("rejects switching without a configured local endpoint", async () => {
    const { settings } = createSettings();

    await expect(settings.switchChatModel("next")).rejects.toThrow("尚未配置本地模型");
  });

  it("clears the local model and returns the source to cloud", async () => {
    const { settings, read } = createSettings(sharedConfig());

    await settings.clearLocal();

    expect(read()).toEqual({
      version: 1,
      model: { source: "cloud", local: { baseUrl: "", chatModel: "" } },
    });
  });
});
