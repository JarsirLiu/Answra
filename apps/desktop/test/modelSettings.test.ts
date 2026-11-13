import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelCredentialStore } from "@answra/credentials";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: Buffer) =>
      Buffer.from(value.toString("utf8").split("").reverse().join("")),
    decryptString: (value: Buffer) => value.toString("utf8").split("").reverse().join(""),
  },
}));

import {
  ModelSettingsStore,
  type ModelSettingsStorePaths,
} from "../src/main/conversation/modelSettings";

const temporaryDirs: string[] = [];

async function createPaths(): Promise<ModelSettingsStorePaths> {
  const root = await mkdtemp(path.join(tmpdir(), "answra-model-settings-"));
  temporaryDirs.push(root);
  return {
    configPath: path.join(root, "shared", "config.json"),
    legacyPath: path.join(root, "userdata", "conversation-model.json"),
    secretPath: path.join(root, "userdata", "conversation-model-key.json"),
  };
}

function createCredentials(initial: string | null = null): ModelCredentialStore & {
  current(): string | null;
} {
  let apiKey = initial;
  return {
    read: vi.fn(async () => apiKey),
    write: vi.fn(async (value: string) => {
      apiKey = value;
    }),
    clear: vi.fn(async () => {
      apiKey = null;
    }),
    current: () => apiKey,
  };
}

function legacyKey(value: string): string {
  return Buffer.from(value.split("").reverse().join("")).toString("base64");
}

async function writeLegacy(paths: ModelSettingsStorePaths): Promise<void> {
  await mkdir(path.dirname(paths.legacyPath), { recursive: true });
  await writeFile(
    paths.legacyPath,
    JSON.stringify({
      source: "local",
      baseUrl: "http://127.0.0.1:1234/v1/",
      model: "legacy-model",
      answerModel: "legacy-answer",
      encryptedKey: legacyKey("legacy-key"),
    }),
  );
}

async function writeLegacySecret(paths: ModelSettingsStorePaths, apiKey: string): Promise<void> {
  await mkdir(path.dirname(paths.secretPath), { recursive: true });
  await writeFile(paths.secretPath, JSON.stringify({ encryptedKey: legacyKey(apiKey) }));
}

afterEach(async () => {
  await Promise.all(
    temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("ModelSettingsStore", () => {
  it("writes non-secret model settings to the shared file and the key to the keychain", async () => {
    const paths = await createPaths();
    const credentials = createCredentials();
    const store = new ModelSettingsStore(paths, credentials);

    await store.save({
      source: "local",
      baseUrl: "http://127.0.0.1:1234/v1/",
      model: "qwen",
      answerModel: "qwen-vl",
      apiKey: "secret-key",
    });

    await expect(store.revealApiKey()).resolves.toBe("secret-key");
    expect(credentials.current()).toBe("secret-key");
    expect(store.read()).toMatchObject({
      source: "local",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "qwen",
      answerModel: "qwen-vl",
    });
    const shared = await readFile(paths.configPath, "utf8");
    expect(JSON.parse(shared)).toEqual({
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
    expect(shared).not.toContain("secret-key");
    await expect(access(paths.secretPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the shared local endpoint and clears the key when switching to cloud", async () => {
    const paths = await createPaths();
    const credentials = createCredentials();
    const store = new ModelSettingsStore(paths, credentials);
    await store.save({
      source: "local",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "qwen",
      answerModel: "qwen-vl",
      apiKey: "secret-key",
    });

    await store.save({ source: "cloud", baseUrl: "", model: "" });

    expect(store.read()).toMatchObject({
      source: "cloud",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "qwen",
      answerModel: "qwen-vl",
    });
    expect(credentials.current()).toBeNull();
    await expect(store.revealApiKey()).resolves.toBeNull();
  });

  it("keeps an existing keychain key when local settings are saved without a new key", async () => {
    const paths = await createPaths();
    const credentials = createCredentials("existing-key");
    const store = new ModelSettingsStore(paths, credentials);

    await store.save({
      source: "local",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "qwen",
    });

    expect(credentials.current()).toBe("existing-key");
    await expect(store.revealApiKey()).resolves.toBe("existing-key");
  });

  it("migrates the legacy desktop file into shared config and the keychain", async () => {
    const paths = await createPaths();
    await writeLegacy(paths);
    const credentials = createCredentials();
    const store = new ModelSettingsStore(paths, credentials);

    await store.init();

    expect(store.read()).toMatchObject({
      source: "local",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "legacy-model",
      answerModel: "legacy-answer",
    });
    await expect(store.revealApiKey()).resolves.toBe("legacy-key");
    await expect(readFile(paths.configPath, "utf8")).resolves.toContain(
      '"chatModel": "legacy-model"',
    );
    await expect(access(paths.legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(paths.secretPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("migrates the old safeStorage key file into the keychain", async () => {
    const paths = await createPaths();
    await mkdir(path.dirname(paths.configPath), { recursive: true });
    await writeFile(
      paths.configPath,
      JSON.stringify({
        version: 1,
        model: {
          source: "local",
          local: { baseUrl: "http://127.0.0.1:1234/v1", chatModel: "qwen" },
        },
      }),
    );
    await writeLegacySecret(paths, "old-secret");
    const credentials = createCredentials();
    const store = new ModelSettingsStore(paths, credentials);

    await store.init();

    await expect(store.revealApiKey()).resolves.toBe("old-secret");
    await expect(access(paths.secretPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves legacy files when the keychain migration fails", async () => {
    const paths = await createPaths();
    await mkdir(path.dirname(paths.configPath), { recursive: true });
    await writeFile(
      paths.configPath,
      JSON.stringify({
        version: 1,
        model: {
          source: "local",
          local: { baseUrl: "http://127.0.0.1:1234/v1", chatModel: "qwen" },
        },
      }),
    );
    await writeLegacySecret(paths, "old-secret");
    const credentials = createCredentials();
    credentials.read = vi.fn(async () => null);
    credentials.write = vi.fn(async () => {
      throw new Error("keychain unavailable");
    });
    const store = new ModelSettingsStore(paths, credentials);

    await store.init();

    await expect(access(paths.secretPath)).resolves.toBeUndefined();
  });

  it("clears shared config, keychain, and legacy files", async () => {
    const paths = await createPaths();
    await writeLegacy(paths);
    const credentials = createCredentials();
    const store = new ModelSettingsStore(paths, credentials);
    await store.save({
      source: "local",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "qwen",
      apiKey: "secret-key",
    });

    await store.clear();

    expect(store.read()).toEqual({ source: "cloud", baseUrl: "", model: "" });
    expect(credentials.current()).toBeNull();
    await expect(access(paths.configPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(paths.secretPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(paths.legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
