import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelCredentialStore } from "@answra/credentials";
import type { TtsProviderDraft } from "@answra/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TtsSettingsStore } from "../../src/main/tts/ttsSettingsStore";

const temporaryDirs: string[] = [];

async function createConfigPath(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "answra-tts-settings-"));
  temporaryDirs.push(root);
  return path.join(root, "shared", "config.json");
}

function createCredentials() {
  const secrets = new Map<string, string>();
  const stores = new Map<string, ModelCredentialStore>();
  return {
    secrets,
    get(providerId: string): ModelCredentialStore {
      const existing = stores.get(providerId);
      if (existing !== undefined) return existing;
      const store: ModelCredentialStore = {
        read: vi.fn(async () => secrets.get(providerId) ?? null),
        write: vi.fn(async (value: string) => {
          secrets.set(providerId, value);
        }),
        clear: vi.fn(async () => {
          secrets.delete(providerId);
        }),
      };
      stores.set(providerId, store);
      return store;
    },
  };
}

function minimax(overrides: Partial<TtsProviderDraft> = {}): TtsProviderDraft {
  return {
    id: "minimax",
    label: "MiniMax",
    protocol: "minimax-native",
    baseUrl: "https://api.minimax.io",
    model: "speech-2.8-turbo",
    voice: "voice-1",
    ...overrides,
  };
}

function mimo(overrides: Partial<TtsProviderDraft> = {}): TtsProviderDraft {
  return {
    id: "mimo",
    label: "MiMo",
    protocol: "chat-audio",
    baseUrl: "https://api.xiaomimimo.com/v1",
    model: "mimo-v2.5-tts",
    voice: "mimo_default",
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("TtsSettingsStore", () => {
  it("keeps the model section when writing the tts section", async () => {
    const configPath = await createConfigPath();
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        model: {
          source: "local",
          local: { baseUrl: "http://127.0.0.1:1234/v1", chatModel: "qwen" },
        },
      }),
    );
    const store = new TtsSettingsStore({
      configPath,
      createCredential: createCredentials().get,
    });

    await store.save({ provider: minimax() });

    const raw = JSON.parse(await readFile(configPath, "utf8"));
    expect(raw.model).toEqual({
      source: "local",
      local: { baseUrl: "http://127.0.0.1:1234/v1", chatModel: "qwen" },
    });
    expect(raw.tts).toEqual({
      provider: {
        id: "minimax",
        label: "MiniMax",
        protocol: "minimax-native",
        baseUrl: "https://api.minimax.io",
        model: "speech-2.8-turbo",
        voice: "voice-1",
      },
    });
    expect(JSON.stringify(raw)).not.toContain("secret");
  });

  it("writes the key, keeps it when apiKey is omitted, and clears it with the provider", async () => {
    const configPath = await createConfigPath();
    const credentials = createCredentials();
    const store = new TtsSettingsStore({ configPath, createCredential: credentials.get });

    await store.save({ provider: minimax({ apiKey: "first-key" }) });
    expect(credentials.secrets.get("minimax")).toBe("first-key");
    expect((await store.view()).provider?.hasApiKey).toBe(true);

    await store.save({ provider: minimax() });
    expect(credentials.secrets.get("minimax")).toBe("first-key");
    await expect(store.revealApiKey("minimax")).resolves.toBe("first-key");

    await store.save({ provider: null });
    expect(credentials.secrets.has("minimax")).toBe(false);
    expect((await store.view()).provider).toBeNull();
  });

  it("clears the key of the previous provider when switching vendors", async () => {
    const configPath = await createConfigPath();
    const credentials = createCredentials();
    const store = new TtsSettingsStore({ configPath, createCredential: credentials.get });

    await store.save({ provider: minimax({ apiKey: "minimax-key" }) });
    expect(credentials.secrets.get("minimax")).toBe("minimax-key");

    await store.save({ provider: mimo({ apiKey: "mimo-key" }) });
    expect(credentials.secrets.has("minimax")).toBe(false);
    expect(credentials.secrets.get("mimo")).toBe("mimo-key");
    await expect(store.revealApiKey("minimax")).resolves.toBeNull();
    await expect(store.revealApiKey("mimo")).resolves.toBe("mimo-key");
  });

  it("exposes adapter capabilities and rejects an invalid provider id", async () => {
    const configPath = await createConfigPath();
    const store = new TtsSettingsStore({
      configPath,
      createCredential: createCredentials().get,
    });

    const view = await store.save({ provider: minimax({ protocol: "openai-compatible" }) });
    expect(view.provider?.capabilities).toMatchObject({ formats: ["mp3"], maxChars: 1_000 });

    await expect(store.save({ provider: minimax({ id: "MiniMax" }) })).rejects.toThrow(
      /只允许小写字母、数字与连字符/,
    );
  });

  it("does not surface a keychain failure as an unreachable settings page", async () => {
    const configPath = await createConfigPath();
    const store = new TtsSettingsStore({
      configPath,
      createCredential: () => ({
        read: vi.fn(async () => {
          throw new Error("keychain unavailable");
        }),
        write: vi.fn(async () => undefined),
        clear: vi.fn(async () => undefined),
      }),
    });
    await store.save({ provider: minimax() });

    await expect(store.view()).resolves.toMatchObject({
      provider: expect.objectContaining({ hasApiKey: false }),
    });
    await expect(store.revealApiKey("minimax")).rejects.toThrow("keychain unavailable");
  });
});
