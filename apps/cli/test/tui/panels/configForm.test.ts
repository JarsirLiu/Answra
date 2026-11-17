import { describe, expect, it } from "vitest";
import {
  CONFIG_FIELDS,
  configApiKeyLabel,
  configApiKeyUpdate,
  configFormFromData,
  configSaveInput,
  maskApiKey,
  maskApiKeyForInput,
  validateConfigForm,
} from "../../../src/tui/panels/configForm";

describe("configForm", () => {
  it("projects saved config into editable values without a second key source", () => {
    const values = configFormFromData({
      baseUrl: "http://127.0.0.1:1234/v1",
      chatModel: "qwen",
      answerModel: "qwen-vl",
      apiKey: "sk-existing",
    });

    expect(values).toEqual({
      baseUrl: "http://127.0.0.1:1234/v1",
      apiKey: "sk-existing",
      chatModel: "qwen",
      answerModel: "qwen-vl",
    });
  });

  it("trims values and omits a blank answer model", () => {
    expect(
      configSaveInput(
        {
          baseUrl: "  http://127.0.0.1:1234/v1  ",
          apiKey: "sk-existing",
          chatModel: " qwen ",
          answerModel: "   ",
        },
        "sk-existing",
      ),
    ).toEqual({
      baseUrl: "http://127.0.0.1:1234/v1",
      chatModel: "qwen",
      apiKey: { kind: "keep" },
    });
  });

  it("keeps an untouched key and clears only when the user removes it", () => {
    expect(configApiKeyUpdate("sk-existing", "sk-existing")).toEqual({ kind: "keep" });
    expect(configApiKeyUpdate("", "sk-existing")).toEqual({ kind: "clear" });
    expect(configApiKeyUpdate("  -  ", "sk-existing")).toEqual({ kind: "clear" });
    expect(configApiKeyUpdate(" sk-new ", "sk-existing")).toEqual({
      kind: "set",
      value: "sk-new",
    });
    expect(configApiKeyUpdate("", "")).toEqual({ kind: "keep" });
  });

  it("labels the API key state without revealing the full value", () => {
    expect(configApiKeyLabel("", "")).toBe("(未配置)");
    expect(configApiKeyLabel("sk-existing", "sk-existing")).toBe("已保存");
    expect(configApiKeyLabel("sk-existing", "sk-new")).toBe("将更新");
    expect(configApiKeyLabel("sk-existing", "")).toBe("将清除");
    expect(maskApiKey("sk-existing-1234")).toBe("••••1234");
    expect(maskApiKey("short")).toBe("••••");
    expect(maskApiKeyForInput("sk-existing-1234")).toBe(`${"•".repeat(12)}1234`);
    expect(maskApiKeyForInput("short")).toBe("•••••");
  });

  it("requires a base URL and chat model but leaves URL validation to model settings", () => {
    expect(
      validateConfigForm({
        baseUrl: "not-a-url",
        apiKey: "",
        chatModel: "qwen",
        answerModel: "",
      }),
    ).toBeUndefined();
    expect(
      validateConfigForm({
        baseUrl: " ",
        apiKey: "",
        chatModel: "qwen",
        answerModel: "",
      }),
    ).toBe("请填写 Base URL。");
    expect(
      validateConfigForm({
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "",
        chatModel: " ",
        answerModel: "",
      }),
    ).toBe("请填写 Chat 模型 ID。");
  });

  it("keeps the settings order without a separate save row", () => {
    expect(CONFIG_FIELDS).toEqual(["baseUrl", "apiKey", "chatModel", "answerModel"]);
  });
});
