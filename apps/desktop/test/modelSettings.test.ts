import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

afterEach(async () => {
  await Promise.all(
    temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("ModelSettingsStore", () => {
  it("writes non-secret model settings to the shared file and keeps the key encrypted", async () => {
    const paths = await createPaths();
    const store = new ModelSettingsStore(paths);

    await store.save({
      source: "local",
      baseUrl: "http://127.0.0.1:1234/v1/",
      model: "qwen",
      answerModel: "qwen-vl",
      apiKey: "secret-key",
    });

    await expect(store.revealApiKey()).resolves.toBe("secret-key");
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
    expect(await readFile(paths.secretPath, "utf8")).not.toContain("secret-key");
  });

  it("keeps the shared local endpoint when the active source switches to cloud", async () => {
    const paths = await createPaths();
    const store = new ModelSettingsStore(paths);
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
    await expect(store.revealApiKey()).resolves.toBeNull();
  });

  it("migrates the legacy desktop file into shared config and encrypted secret", async () => {
    const paths = await createPaths();
    await writeLegacy(paths);
    const store = new ModelSettingsStore(paths);

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
  });

  it("clears shared config, secret, and legacy files", async () => {
    const paths = await createPaths();
    await writeLegacy(paths);
    const store = new ModelSettingsStore(paths);
    await store.save({
      source: "local",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "qwen",
      apiKey: "secret-key",
    });

    await store.clear();

    expect(store.read()).toEqual({ source: "cloud", baseUrl: "", model: "" });
    await expect(access(paths.configPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(paths.secretPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(paths.legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
