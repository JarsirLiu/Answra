import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPendingUpdateOnLaunch } from "../src/main/updater/applyPendingUpdate";
import {
  pendingUpdateMarkerPath,
  readPendingUpdate,
  writePendingUpdate,
} from "../src/main/updater/pendingUpdate";

/** 启动时安装：只在新版本可用且安装器存在时拉起，失败则保留记录等待重试。 */
describe("applyPendingUpdateOnLaunch", () => {
  let configDir: string;
  let markerPath: string;
  let installerPath: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "answra-apply-update-"));
    markerPath = pendingUpdateMarkerPath(configDir);
    installerPath = join(configDir, "Answra-Setup.exe");
    writeFileSync(installerPath, "installer");
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  it("launches the cached installer and stops the launch flow", () => {
    writePendingUpdate(markerPath, { version: "0.2.0", installerPath });
    const quit = vi.fn();
    const spawnInstaller = vi.fn(() => true);

    const applied = applyPendingUpdateOnLaunch({
      configDir,
      currentVersion: "0.1.0",
      platform: "win32",
      quit,
      spawnInstaller,
      log: () => undefined,
    });

    expect(applied).toBe(true);
    expect(spawnInstaller).toHaveBeenCalledWith(installerPath);
    expect(quit).toHaveBeenCalledOnce();
    expect(readPendingUpdate(markerPath)).toBeNull();
  });

  it("clears the marker when the pending version is not newer", () => {
    writePendingUpdate(markerPath, { version: "0.1.0", installerPath });
    const quit = vi.fn();
    const spawnInstaller = vi.fn(() => true);

    expect(
      applyPendingUpdateOnLaunch({
        configDir,
        currentVersion: "0.1.0",
        platform: "win32",
        quit,
        spawnInstaller,
        log: () => undefined,
      }),
    ).toBe(false);
    expect(spawnInstaller).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
    expect(existsSync(markerPath)).toBe(false);
  });

  it("clears a stale marker when the cached installer is gone", () => {
    rmSync(installerPath);
    writePendingUpdate(markerPath, { version: "0.2.0", installerPath });

    expect(
      applyPendingUpdateOnLaunch({
        configDir,
        currentVersion: "0.1.0",
        platform: "win32",
        quit: vi.fn(),
        spawnInstaller: vi.fn(() => true),
        log: () => undefined,
      }),
    ).toBe(false);
    expect(existsSync(markerPath)).toBe(false);
  });

  it("keeps the marker for a later retry when the installer cannot start", () => {
    writePendingUpdate(markerPath, { version: "0.2.0", installerPath });
    const quit = vi.fn();

    expect(
      applyPendingUpdateOnLaunch({
        configDir,
        currentVersion: "0.1.0",
        platform: "win32",
        quit,
        spawnInstaller: () => false,
        log: () => undefined,
      }),
    ).toBe(false);
    expect(quit).not.toHaveBeenCalled();
    expect(readPendingUpdate(markerPath)).toEqual({ version: "0.2.0", installerPath });
  });

  it("does nothing outside Windows", () => {
    writePendingUpdate(markerPath, { version: "0.2.0", installerPath });
    const spawnInstaller = vi.fn(() => true);

    expect(
      applyPendingUpdateOnLaunch({
        configDir,
        currentVersion: "0.1.0",
        platform: "darwin",
        quit: vi.fn(),
        spawnInstaller,
        log: () => undefined,
      }),
    ).toBe(false);
    expect(spawnInstaller).not.toHaveBeenCalled();
    expect(existsSync(markerPath)).toBe(true);
  });

  it("is a no-op without a pending record", () => {
    expect(
      applyPendingUpdateOnLaunch({
        configDir,
        currentVersion: "0.1.0",
        platform: "win32",
        quit: vi.fn(),
        log: () => undefined,
      }),
    ).toBe(false);
  });
});
