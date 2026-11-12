import { AI_SERVICE_BASE_URL, CLI_API_KEY, CLI_MODEL } from "@answra/shared";
import { describe, expect, it } from "vitest";
import { CliConfigError } from "../src/cli/errors";
import { resolveModelConfig } from "../src/config/modelConfig";

const code = { kind: "code" as const };

function env(values: Record<string, string | undefined>): Record<string, string | undefined> {
  return values;
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
    expect(() => resolveModelConfig(code, env({}))).toThrowError(`缺少 ${AI_SERVICE_BASE_URL}。`);
    expect(() =>
      resolveModelConfig(code, env({ [AI_SERVICE_BASE_URL]: "http://127.0.0.1:1234/v1" })),
    ).toThrowError(`缺少 ${CLI_MODEL}。`);
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
