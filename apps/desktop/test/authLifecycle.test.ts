import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, setAsDefaultProtocolClient: vi.fn() },
}));

import { resolveDeviceDescriptor } from "../src/main/auth/deviceInfo";
import { protocolClientRegistration } from "../src/main/auth/lifecycle";

/** 深链注册参数：打包版只用 scheme；开发态必须带上 execPath + 入口脚本。 */
describe("protocolClientRegistration", () => {
  it("registers execPath and entry script for a dev (defaultApp) run", () => {
    expect(
      protocolClientRegistration({
        defaultApp: true,
        execPath: "C:/electron/electron.exe",
        entry: "apps/desktop/out/main/index.cjs",
      }),
    ).toEqual({
      scheme: "answra",
      execPath: "C:/electron/electron.exe",
      args: [path.resolve("apps/desktop/out/main/index.cjs")],
    });
  });

  it("registers the scheme alone for a packaged build", () => {
    expect(
      protocolClientRegistration({
        defaultApp: false,
        execPath: "C:/Program Files/Answra/Answra.exe",
        entry: undefined,
      }),
    ).toEqual({ scheme: "answra" });
  });

  it("does not pass a script path when argv[1] is missing", () => {
    expect(
      protocolClientRegistration({
        defaultApp: true,
        execPath: "C:/electron/electron.exe",
        entry: undefined,
      }),
    ).toEqual({ scheme: "answra" });
  });
});

/** 设备身份：同一目录复用同一 ID，缺失时重新生成。 */
describe("resolveDeviceDescriptor", () => {
  it("persists a stable device id", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "answra-device-"));
    const first = await resolveDeviceDescriptor(dir);
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.os).toBe(process.platform);
    expect(first.name).toBeTruthy();

    const stored = JSON.parse(await readFile(path.join(dir, "desktop-device.json"), "utf8"));
    expect(stored.id).toBe(first.id);
    // 同目录第二次解析命中缓存，返回同一身份。
    expect(await resolveDeviceDescriptor(dir)).toEqual(first);
  });

  it("generates a fresh id when the file is corrupted", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "answra-device-"));
    await writeFile(path.join(dir, "desktop-device.json"), "not json");
    const descriptor = await resolveDeviceDescriptor(dir);
    expect(descriptor.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
