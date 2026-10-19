import { beforeEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({
  cloudConfig: null as {
    chat: { baseUrl: string; model: string; auth?: "cloud" | "local" };
    answer: { baseUrl: string; model: string; auth?: "cloud" | "local" };
  } | null,
  hasSession: true,
  accessToken: "cloud-token",
}));

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: Buffer) => Buffer.from(`enc:${value.toString("utf8")}`),
    decryptString: (value: Buffer) => value.toString("utf8").replace(/^enc:/, ""),
  },
}));

import { AUTH_REQUIRED_CODE, type ConversationModelSettings } from "@answra/shared";
import { ModelRouter, type ModelSettingsStorePort } from "../src/main/conversation/modelRouter";
import {
  defaultModelSettings,
  toView,
  validateModelSettings,
} from "../src/main/conversation/modelSettings";

function createFakeStore(initial = defaultModelSettings()): ModelSettingsStorePort & {
  current: () => ReturnType<typeof defaultModelSettings>;
} {
  let current = initial;
  return {
    current: () => current,
    init: vi.fn(async () => undefined),
    read: vi.fn(() => current),
    save: vi.fn(async (settings: ConversationModelSettings) => {
      current = {
        source: settings.source,
        baseUrl: settings.baseUrl,
        model: settings.model,
        answerModel: settings.answerModel,
      };
    }),
    clear: vi.fn(async () => {
      current = defaultModelSettings();
    }),
    // 真实存储经 safeStorage 加解密，这里用同一 `enc:` 约定模拟解密。
    revealApiKey: vi.fn(async () => current.encryptedKey?.replace(/^enc:/, "") ?? null),
  };
}

function createRouter(store: ModelSettingsStorePort, localAvailable = true): ModelRouter {
  return new ModelRouter({
    store,
    localAvailable,
    cloud: {
      // 真实 AuthService 无会话时直接返回 null（与登录态绑定）。
      modelConfig: () => (shared.hasSession ? shared.cloudConfig : null),
      hasSession: () => shared.hasSession,
      accessToken: async () => shared.accessToken,
    },
  });
}

describe("model router source selection", () => {
  beforeEach(() => {
    shared.cloudConfig = {
      chat: { baseUrl: "https://cloud.example/v1", model: "cloud-model", auth: "cloud" },
      answer: { baseUrl: "https://cloud.example/v1", model: "cloud-model", auth: "cloud" },
    };
    shared.hasSession = true;
    shared.accessToken = "cloud-token";
  });

  it("resolves the local endpoint with the saved key and no login", async () => {
    const store = createFakeStore({
      source: "local",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "local-model",
      answerModel: "answer-model",
      encryptedKey: "enc:local-key",
    });
    const router = createRouter(store);

    await expect(router.resolve()).resolves.toEqual({
      config: {
        chat: { baseUrl: "http://127.0.0.1:1234/v1", model: "local-model", auth: "local" },
        answer: { baseUrl: "http://127.0.0.1:1234/v1", model: "answer-model", auth: "local" },
      },
      accessToken: "local-key",
    });
    expect(router.canSend()).toBe(true);
  });

  it("falls back to the chat model for answer when answerModel is empty", async () => {
    const store = createFakeStore({
      source: "local",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "local-model",
      encryptedKey: "enc:local-key",
    });
    const resolved = await createRouter(store).resolve();
    expect(resolved.config.answer.model).toBe("local-model");
  });

  it("rejects local calls that are not configured with a configuration hint", async () => {
    const router = createRouter(createFakeStore({ source: "local", baseUrl: "", model: "" }));
    await expect(router.resolve()).rejects.toThrow("请先在设置 → 模型中配置本地模型服务");
  });

  it("resolves the cloud subscription with the access token", async () => {
    const router = createRouter(createFakeStore({ source: "cloud", baseUrl: "", model: "" }));
    await expect(router.resolve()).resolves.toEqual({
      config: shared.cloudConfig,
      accessToken: "cloud-token",
    });
  });

  it("rejects cloud calls without a session using the shared auth-required code", async () => {
    shared.hasSession = false;
    const router = createRouter(createFakeStore({ source: "cloud", baseUrl: "", model: "" }));
    await expect(router.resolve()).rejects.toThrow(AUTH_REQUIRED_CODE);
    expect(router.canSend()).toBe(false);
  });

  it("ignores the local source in packaged builds and uses the cloud", async () => {
    const store = createFakeStore({
      source: "local",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "local-model",
      encryptedKey: "enc:local-key",
    });
    const router = createRouter(store, false);
    expect(router.getView().source).toBe("cloud");
    await expect(router.resolve()).resolves.toMatchObject({ accessToken: "cloud-token" });
  });

  it("rejects saving the local source in packaged builds", async () => {
    const router = createRouter(createFakeStore(), false);
    await expect(
      router.save({ source: "local", baseUrl: "http://127.0.0.1:1234/v1", model: "m" }),
    ).rejects.toThrow("当前版本仅支持云端订阅");
  });

  it("saves the local settings and clears them back to cloud", async () => {
    const store = createFakeStore();
    const router = createRouter(store);
    const input = {
      source: "local" as const,
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "local-model",
      answerModel: "answer-model",
      apiKey: "local-key",
    };
    await expect(router.save(input)).resolves.toMatchObject({
      source: "local",
      configured: true,
    });
    expect(store.save).toHaveBeenCalledWith(input);
    await expect(router.clear()).resolves.toMatchObject({ source: "cloud", configured: false });
  });
});

describe("model settings validation", () => {
  it("normalizes a valid local settings payload", () => {
    expect(
      validateModelSettings({
        source: "local",
        baseUrl: " http://127.0.0.1:1234/v1/ ",
        model: " local-model ",
        answerModel: "  ",
        apiKey: "  ",
      }),
    ).toEqual({
      source: "local",
      baseUrl: "http://127.0.0.1:1234/v1/",
      model: "local-model",
      answerModel: undefined,
      apiKey: undefined,
    });
  });

  it("rejects a local endpoint without a model id", () => {
    expect(() =>
      validateModelSettings({ source: "local", baseUrl: "http://127.0.0.1:1234/v1", model: " " }),
    ).toThrow("请填写模型 ID");
  });

  it("rejects a non-http local endpoint", () => {
    expect(() =>
      validateModelSettings({ source: "local", baseUrl: "ftp://127.0.0.1", model: "m" }),
    ).toThrow("http(s)://");
  });

  it("rejects an endpoint with embedded credentials", () => {
    expect(() =>
      validateModelSettings({
        source: "local",
        baseUrl: "http://user:pass@127.0.0.1/v1",
        model: "m",
      }),
    ).toThrow("账号密码");
  });

  it("defaults an unknown source to cloud", () => {
    expect(validateModelSettings({ source: "other", baseUrl: "", model: "" }).source).toBe("cloud");
  });
});

describe("model settings view", () => {
  it("folds the local source into cloud when local is unavailable", () => {
    const view = toView(
      { source: "local", baseUrl: "http://127.0.0.1:1234/v1", model: "m" },
      false,
    );
    expect(view.source).toBe("cloud");
    expect(view.localAvailable).toBe(false);
  });

  it("keeps the local source in development", () => {
    const view = toView({ source: "local", baseUrl: "http://127.0.0.1:1234/v1", model: "m" }, true);
    expect(view.source).toBe("local");
    expect(view.configured).toBe(true);
  });
});
