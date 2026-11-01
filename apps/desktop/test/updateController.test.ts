import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeUpdater = vi.hoisted(() => {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    logger: undefined as unknown,
    handlers,
    on(event: string, handler: (...args: unknown[]) => void) {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
    emit(event: string, ...args: unknown[]) {
      for (const handler of handlers.get(event) ?? []) handler(...args);
    },
    checkForUpdates: () => Promise.resolve(undefined),
    removeAllListeners: () => handlers.clear(),
  };
});

vi.mock("electron-updater", () => ({ autoUpdater: fakeUpdater }));

import { createUpdateController } from "../src/main/updater/updateController";

/** 更新控制器：Windows 只落待安装记录，其他平台沿用退出时安装。 */
describe("createUpdateController", () => {
  let configDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    configDir = mkdtempSync(join(tmpdir(), "answra-update-controller-"));
    fakeUpdater.autoInstallOnAppQuit = true;
    fakeUpdater.handlers.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(configDir, { recursive: true, force: true });
  });

  it("defers Windows installs to the next launch by persisting a marker", () => {
    const controller = createUpdateController({
      isPackaged: true,
      configDir,
      platform: "win32",
      log: () => undefined,
    });

    expect(fakeUpdater.autoInstallOnAppQuit).toBe(false);
    fakeUpdater.emit("update-downloaded", {
      version: "0.2.0",
      downloadedFile: "C:\\cache\\Answra-Setup.exe",
    });

    const markerPath = join(configDir, "pending-update.json");
    expect(existsSync(markerPath)).toBe(true);
    expect(JSON.parse(readFileSync(markerPath, "utf8"))).toEqual({
      version: "0.2.0",
      installerPath: "C:\\cache\\Answra-Setup.exe",
    });
    controller.dispose();
  });

  it("keeps quit-time installs on non-Windows platforms", () => {
    const controller = createUpdateController({
      isPackaged: true,
      configDir,
      platform: "darwin",
      log: () => undefined,
    });

    expect(fakeUpdater.autoInstallOnAppQuit).toBe(true);
    fakeUpdater.emit("update-downloaded", {
      version: "0.2.0",
      downloadedFile: "/cache/Answra.zip",
    });
    expect(existsSync(join(configDir, "pending-update.json"))).toBe(false);
    controller.dispose();
  });

  it("does nothing when unpackaged or on Linux", () => {
    const unpackaged = createUpdateController({
      isPackaged: false,
      configDir,
      platform: "win32",
      log: () => undefined,
    });
    const linux = createUpdateController({
      isPackaged: true,
      configDir,
      platform: "linux",
      log: () => undefined,
    });
    expect(fakeUpdater.handlers.size).toBe(0);
    unpackaged.dispose();
    linux.dispose();
  });
});
