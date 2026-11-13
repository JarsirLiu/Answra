import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ClientConfig,
  defaultClientConfig,
  parseClientConfig,
  readClientConfig,
  resolveDefaultConfigDir,
  sharedConfigPath,
  writeClientConfig,
} from "../src";

const temporaryDirs: string[] = [];

async function temporaryDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "answra-config-"));
  temporaryDirs.push(dir);
  return dir;
}

async function configFile(): Promise<string> {
  return sharedConfigPath(await temporaryDir());
}

function localConfig(): ClientConfig {
  return {
    version: 1,
    model: {
      source: "local",
      local: {
        baseUrl: "http://127.0.0.1:1234/v1/",
        chatModel: "qwen",
        answerModel: "qwen-vl",
      },
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("shared client config", () => {
  it("writes normalized non-secret model settings and reads them back", async () => {
    const file = await configFile();
    await writeClientConfig(file, localConfig());

    await expect(readClientConfig(file)).resolves.toEqual({
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
    const raw = await readFile(file, "utf8");
    expect(raw).not.toContain("apiKey");
    expect(raw).not.toContain("secret");
  });

  it("returns null when the shared file does not exist", async () => {
    await expect(readClientConfig(await configFile())).resolves.toBeNull();
  });

  it("rejects unsupported versions and incomplete local endpoints", async () => {
    const file = await configFile();
    await writeFile(file, JSON.stringify({ version: 2, model: defaultClientConfig().model }));
    await expect(readClientConfig(file)).rejects.toThrow("不支持的共享配置版本");

    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        model: {
          source: "local",
          local: { baseUrl: "http://127.0.0.1:1234/v1", chatModel: "" },
        },
      }),
    );
    await expect(readClientConfig(file)).rejects.toThrow("必须同时设置或同时留空");
  });

  it("rejects credentialed and non-http local endpoints", async () => {
    for (const baseUrl of ["ftp://127.0.0.1/v1", "http://user:pass@127.0.0.1/v1"]) {
      expect(() =>
        parseClientConfig({
          version: 1,
          model: { source: "local", local: { baseUrl, chatModel: "m" } },
        }),
      ).toThrow();
    }
  });

  it("resolves the platform data root consistently", () => {
    const homeDir = "C:\\Users\\me";
    expect(
      resolveDefaultConfigDir({
        platform: "win32",
        env: { APPDATA: "C:\\Users\\me\\AppData\\Roaming" },
        homeDir,
      }),
    ).toBe(path.join("C:\\Users\\me\\AppData\\Roaming", "Answra"));
    expect(resolveDefaultConfigDir({ platform: "darwin", env: {}, homeDir })).toBe(
      path.join(homeDir, "Library", "Application Support", "Answra"),
    );
    expect(
      resolveDefaultConfigDir({
        platform: "linux",
        env: { XDG_CONFIG_HOME: "/home/me/.config" },
        homeDir: "/home/me",
      }),
    ).toBe(path.join("/home/me/.config", "Answra"));
  });
});
