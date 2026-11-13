import type { ClientConfig } from "@answra/config";
import { AI_SERVICE_BASE_URL, CLI_API_KEY, CLI_MODEL } from "@answra/shared";
import { describe, expect, it } from "vitest";
import { CliConfigError } from "../src/cli/errors";
import { resolveModelConfig } from "../src/config/modelConfig";

const code = { kind: "code" as const };

function env(values: Record<string, string | undefined>): Record<string, string | undefined> {
  return values;
}

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

describe("resolveModelConfig", () => {
  it("maps the same local endpoint to chat and answer", () => {
    const resolved = resolveModelConfig(
      code,
      env({
        [AI_SERVICE_BASE_URL]: "http://127.0.0.1:1234/v1/",
        [CLI_MODEL]: " local-model ",
        [CLI_API_KEY]: " secret ",
      }),
    );

    expect(resolved.accessToken).toBe("secret");
    expect(resolved.config).toEqual({
      chat: { baseUrl: "http://127.0.0.1:1234/v1", model: "local-model", auth: "local" },
      answer: { baseUrl: "http://127.0.0.1:1234/v1", model: "local-model", auth: "local" },
    });
  });

  it("lets command options override the environment and allows an empty key", () => {
    const resolved = resolveModelConfig(
      { kind: "code", baseUrl: "https://example.com/v1", model: "option-model", apiKey: " " },
      env({
        [AI_SERVICE_BASE_URL]: "http://ignored:1234/v1",
        [CLI_MODEL]: "ignored-model",
        [CLI_API_KEY]: "ignored-key",
      }),
    );

    expect(resolved.accessToken).toBe("");
    expect(resolved.config.chat).toMatchObject({
      baseUrl: "https://example.com/v1",
      model: "option-model",
    });
  });

  it("fails explicitly when required values are absent", () => {
    expect(() => resolveModelConfig(code, env({}))).toThrowError(CliConfigError);
    expect(() => resolveModelConfig(code, env({}))).toThrowError(
      `缺少 ${AI_SERVICE_BASE_URL}（共享配置也没有本地模型地址）。`,
    );
    expect(() =>
      resolveModelConfig(code, env({ [AI_SERVICE_BASE_URL]: "http://127.0.0.1:1234/v1" })),
    ).toThrowError(`缺少 ${CLI_MODEL}（共享配置也没有本地模型 ID）。`);
  });

  it("uses the shared local model when flags and environment are absent", () => {
    expect(resolveModelConfig(code, env({}), sharedConfig())).toEqual({
      config: {
        chat: { baseUrl: "http://127.0.0.1:1234/v1", model: "shared-model", auth: "local" },
        answer: {
          baseUrl: "http://127.0.0.1:1234/v1",
          model: "shared-answer",
          auth: "local",
        },
      },
      accessToken: "",
    });
  });

  it("treats empty environment placeholders as absent and falls back to shared config", () => {
    const resolved = resolveModelConfig(
      code,
      env({ [AI_SERVICE_BASE_URL]: "", [CLI_MODEL]: "  " }),
      sharedConfig(),
    );
    expect(resolved.config.chat).toEqual({
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "shared-model",
      auth: "local",
    });
    expect(resolved.config.answer.model).toBe("shared-answer");
  });

  it("overrides shared values per field and reuses the override for answer", () => {
    const resolved = resolveModelConfig(
      { kind: "code", model: "option-model" },
      env({}),
      sharedConfig(),
    );
    expect(resolved.config).toEqual({
      chat: { baseUrl: "http://127.0.0.1:1234/v1", model: "option-model", auth: "local" },
      answer: { baseUrl: "http://127.0.0.1:1234/v1", model: "option-model", auth: "local" },
    });
  });

  it("does not invent a local endpoint when the shared config has not been configured", () => {
    expect(() =>
      resolveModelConfig(
        code,
        env({}),
        sharedConfig({ baseUrl: "", chatModel: "", answerModel: undefined }),
      ),
    ).toThrowError(CliConfigError);
  });

  it("rejects malformed, non-http, and credentialed endpoints", () => {
    for (const baseUrl of [
      "not-a-url",
      "ftp://example.com/v1",
      "http://user:pass@example.com/v1",
    ]) {
      expect(() => resolveModelConfig({ kind: "code", baseUrl, model: "m" }, env({}))).toThrowError(
        CliConfigError,
      );
    }
  });
});
