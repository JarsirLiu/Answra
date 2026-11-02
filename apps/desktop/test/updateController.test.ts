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
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    removeAllListeners: () => handlers.clear(),
  };
});

const fakeInstallPendingUpdate = vi.hoisted(() => vi.fn());

vi.mock("electron-updater", () => ({ autoUpdater: fakeUpdater }));
vi.mock("../src/main/updater/applyPendingUpdate", () => ({
  installPendingUpdate: fakeInstallPendingUpdate,
}));

import { createUpdateController } from "../src/main/updater/updateController";

/** 更新控制器：状态机、手动检查/重试与立即安装。 */
describe("createUpdateController", () => {
  let configDir: string;

  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000 });
    configDir = mkdtempSync(join(tmpdir(), "answra-update-controller-"));
    fakeUpdater.autoInstallOnAppQuit = true;
    fakeUpdater.handlers.clear();
    fakeUpdater.checkForUpdates.mockReset().mockResolvedValue(undefined);
    fakeUpdater.downloadUpdate.mockReset().mockResolvedValue(undefined);
    fakeUpdater.quitAndInstall.mockReset();
    fakeInstallPendingUpdate.mockReset().mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(configDir, { recursive: true, force: true });
  });

  function createController(overrides: Partial<Parameters<typeof createUpdateController>[0]> = {}) {
    const quit = vi.fn();
    const controller = createUpdateController({
      isPackaged: true,
      currentVersion: "0.1.0",
      configDir,
      platform: "win32",
      quit,
      log: () => undefined,
      ...overrides,
    });
    return { controller, quit };
  }

  it("defers Windows installs to the next launch by persisting a marker", () => {
    const { controller } = createController();

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
    expect(controller.getStatus()).toMatchObject({
      phase: "downloaded",
      availableVersion: "0.2.0",
      installMode: "next-launch",
      downloadedPath: "C:\\cache\\Answra-Setup.exe",
    });
    controller.dispose();
  });

  it("keeps quit-time installs on non-Windows, non-macOS platforms", () => {
    const { controller } = createController({ platform: "freebsd" });

    expect(fakeUpdater.autoInstallOnAppQuit).toBe(true);
    fakeUpdater.emit("update-downloaded", {
      version: "0.2.0",
      downloadedFile: "/cache/Answra.AppImage",
    });
    expect(existsSync(join(configDir, "pending-update.json"))).toBe(false);
    expect(controller.getStatus().installMode).toBe("on-quit");
    controller.dispose();
  });

  it("waits for the user instead of silently downloading on every platform", async () => {
    const { controller } = createController();
    fakeUpdater.checkForUpdates.mockImplementation(() => {
      fakeUpdater.emit("update-available", { version: "0.2.0" });
      return Promise.resolve(undefined);
    });

    expect(fakeUpdater.autoDownload).toBe(false);
    expect(fakeUpdater.autoInstallOnAppQuit).toBe(false);

    const available = await controller.check({ manual: true });
    expect(available).toMatchObject({
      phase: "available",
      availableVersion: "0.2.0",
      installMode: "next-launch",
      downloadedPath: null,
    });
    expect(fakeUpdater.downloadUpdate).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("prepares the macOS zip for a swap install on demand", async () => {
    const swap = fakeSwapInstaller();
    const { controller, quit } = createController({ platform: "darwin", macSwapInstaller: swap });
    fakeUpdater.checkForUpdates.mockImplementation(() => {
      fakeUpdater.emit("update-available", { version: "0.2.0" });
      return Promise.resolve(undefined);
    });
    fakeUpdater.downloadUpdate.mockImplementation(() => {
      fakeUpdater.emit("update-downloaded", {
        version: "0.2.0",
        downloadedFile: "/cache/Answra-zip",
      });
      return Promise.resolve(["/cache/Answra-zip"]);
    });

    await controller.check({ manual: true });
    const downloaded = await controller.download();
    expect(downloaded).toMatchObject({
      phase: "downloaded",
      installMode: "auto-swap",
      downloadedPath: "/updates/Answra.app",
    });
    expect(swap.extracted).toEqual(["/cache/Answra-zip"]);
    expect(fakeUpdater.autoInstallOnAppQuit).toBe(false);

    expect(await controller.installNow()).toEqual({ started: true });
    expect(swap.installed).toEqual(["/updates/Answra.app"]);
    expect(quit).toHaveBeenCalledOnce();
    expect(fakeUpdater.quitAndInstall).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("keeps macOS running until the swap script confirms it started", async () => {
    const swap = fakeSwapInstaller();
    let resolveStart: (() => void) | undefined;
    swap.startInstall = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
    );
    const { controller, quit } = createController({ platform: "darwin", macSwapInstaller: swap });
    fakeUpdater.checkForUpdates.mockImplementation(() => {
      fakeUpdater.emit("update-available", { version: "0.2.0" });
      return Promise.resolve(undefined);
    });
    fakeUpdater.downloadUpdate.mockImplementation(() => {
      fakeUpdater.emit("update-downloaded", {
        version: "0.2.0",
        downloadedFile: "/cache/Answra-zip",
      });
      return Promise.resolve(["/cache/Answra-zip"]);
    });
    await controller.check({ manual: true });
    await controller.download();

    const install = controller.installNow();
    expect(quit).not.toHaveBeenCalled();
    resolveStart?.();

    expect(await install).toEqual({ started: true });
    expect(quit).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it("keeps macOS running and reports failure when the swap script cannot start", async () => {
    const swap = fakeSwapInstaller();
    swap.startInstall = vi.fn().mockRejectedValue(new Error("spawn failed"));
    const { controller, quit } = createController({ platform: "darwin", macSwapInstaller: swap });
    fakeUpdater.checkForUpdates.mockImplementation(() => {
      fakeUpdater.emit("update-available", { version: "0.2.0" });
      return Promise.resolve(undefined);
    });
    fakeUpdater.downloadUpdate.mockImplementation(() => {
      fakeUpdater.emit("update-downloaded", {
        version: "0.2.0",
        downloadedFile: "/cache/Answra-zip",
      });
      return Promise.resolve(["/cache/Answra-zip"]);
    });
    await controller.check({ manual: true });
    await controller.download();

    expect(await controller.installNow()).toEqual({ started: false });
    expect(quit).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("surfaces a mac swap preparation failure and lets the user retry", async () => {
    const swap = fakeSwapInstaller();
    swap.extract = vi.fn().mockRejectedValue(new Error("ditto failed"));
    const { controller } = createController({ platform: "darwin", macSwapInstaller: swap });
    fakeUpdater.downloadUpdate.mockImplementation(() => {
      fakeUpdater.emit("update-downloaded", {
        version: "0.2.0",
        downloadedFile: "/cache/Answra-zip",
      });
      return Promise.resolve(["/cache/Answra-zip"]);
    });
    fakeUpdater.checkForUpdates.mockImplementation(() => {
      fakeUpdater.emit("update-available", { version: "0.2.0" });
      return Promise.resolve(undefined);
    });

    await controller.check({ manual: true });
    await controller.download();
    expect(controller.getStatus()).toMatchObject({
      phase: "error",
      error: "更新下载失败，请重试",
      downloadedPath: null,
    });

    swap.extract = vi.fn().mockResolvedValue("/updates/Answra.app");
    fakeUpdater.downloadUpdate.mockImplementation(() => {
      fakeUpdater.emit("update-downloaded", {
        version: "0.2.0",
        downloadedFile: "/cache/Answra-zip",
      });
      return Promise.resolve(["/cache/Answra-zip"]);
    });
    const retried = await controller.download();
    expect(retried).toMatchObject({
      phase: "downloaded",
      error: null,
      downloadedPath: "/updates/Answra.app",
    });
    controller.dispose();
  });

  it("reports unsupported without wiring updater listeners or timers", async () => {
    const unpackaged = createController({ isPackaged: false });
    const linux = createController({ platform: "linux" });

    expect(fakeUpdater.handlers.size).toBe(0);
    expect(unpackaged.controller.getStatus()).toMatchObject({
      phase: "unsupported",
      currentVersion: "0.1.0",
    });
    expect(await linux.controller.check({ manual: true })).toMatchObject({
      phase: "unsupported",
    });
    expect(unpackaged.controller.getStatus().lastCheckedAt).toBeNull();
    unpackaged.controller.dispose();
    linux.controller.dispose();
  });

  it("reports the current version and settles a manual check as up to date", async () => {
    const { controller } = createController();
    fakeUpdater.checkForUpdates.mockImplementation(() => {
      fakeUpdater.emit("checking-for-update");
      fakeUpdater.emit("update-not-available", {});
      return Promise.resolve(undefined);
    });

    expect(controller.getStatus()).toMatchObject({
      phase: "idle",
      currentVersion: "0.1.0",
      availableVersion: null,
      lastCheckedAt: null,
    });

    const status = await controller.check({ manual: true });
    expect(status.phase).toBe("up-to-date");
    expect(status.lastCheckedAt).not.toBeNull();
    controller.dispose();
  });

  it("moves from available through downloading to downloaded", async () => {
    const { controller } = createController();
    fakeUpdater.checkForUpdates.mockImplementation(() => {
      fakeUpdater.emit("update-available", { version: "0.2.0" });
      return Promise.resolve(undefined);
    });

    const available = await controller.check({ manual: true });
    expect(available).toMatchObject({
      phase: "available",
      availableVersion: "0.2.0",
    });

    fakeUpdater.emit("download-progress", { percent: 42.4, transferred: 42, total: 100 });
    expect(controller.getStatus()).toMatchObject({
      phase: "downloading",
      progress: { percent: 42.4, transferred: 42, total: 100 },
    });

    fakeUpdater.emit("update-downloaded", {
      version: "0.2.0",
      downloadedFile: "C:\\cache\\Answra-Setup.exe",
    });
    expect(controller.getStatus()).toMatchObject({
      phase: "downloaded",
      progress: null,
      error: null,
    });
    controller.dispose();
  });

  it("shows manual check failures but keeps automatic failures quiet", async () => {
    const { controller } = createController();
    fakeUpdater.checkForUpdates.mockRejectedValue(new Error("offline"));

    const failed = await controller.check({ manual: true });
    expect(failed).toMatchObject({
      phase: "error",
      error: "无法连接更新服务器，请稍后重试",
    });

    fakeUpdater.checkForUpdates.mockRejectedValue(new Error("offline"));
    const silent = await controller.check();
    expect(silent).toMatchObject({ phase: "idle", error: null });
    controller.dispose();
  });

  it("retries a failed download without leaving the error state stuck", async () => {
    const { controller } = createController();
    fakeUpdater.checkForUpdates.mockImplementation(() => {
      fakeUpdater.emit("update-available", { version: "0.2.0" });
      fakeUpdater.emit("error", new Error("download failed"));
      return Promise.resolve(undefined);
    });

    const failed = await controller.check({ manual: true });
    expect(failed).toMatchObject({
      phase: "error",
      availableVersion: "0.2.0",
      error: "更新下载失败，请重试",
    });

    const retrying = await controller.download();
    expect(retrying.phase).toBe("downloading");
    expect(fakeUpdater.downloadUpdate).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it("shares an in-flight check instead of starting a second one", async () => {
    const { controller } = createController();
    let resolveCheck: () => void = () => undefined;
    fakeUpdater.checkForUpdates.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveCheck = resolve;
      }),
    );

    const first = controller.check({ manual: true });
    const second = await controller.check({ manual: true });
    expect(second.phase).toBe("checking");
    expect(fakeUpdater.checkForUpdates).toHaveBeenCalledOnce();

    resolveCheck();
    await first;
    controller.dispose();
  });

  it("throttles chatty progress pushes while keeping the latest status readable", () => {
    const { controller } = createController();
    const listener = vi.fn();
    controller.subscribe(listener);
    fakeUpdater.emit("checking-for-update");
    fakeUpdater.emit("update-available", { version: "0.2.0" });
    listener.mockClear();

    fakeUpdater.emit("download-progress", { percent: 1, transferred: 1, total: 100 });
    listener.mockClear();
    fakeUpdater.emit("download-progress", { percent: 1.1, transferred: 1.1, total: 100 });
    expect(listener).not.toHaveBeenCalled();
    expect(controller.getStatus().progress?.percent).toBe(1.1);

    fakeUpdater.emit("download-progress", { percent: 2.2, transferred: 2.2, total: 100 });
    expect(listener).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it("installs immediately on Windows through the pending record", async () => {
    const { controller, quit } = createController();
    fakeUpdater.emit("update-downloaded", {
      version: "0.2.0",
      downloadedFile: "C:\\cache\\Answra-Setup.exe",
    });

    const result = await controller.installNow();
    expect(result).toEqual({ started: true });
    expect(fakeInstallPendingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        configDir,
        currentVersion: "0.1.0",
        platform: "win32",
      }),
    );
    expect(quit).toHaveBeenCalledOnce();
    expect(fakeUpdater.quitAndInstall).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("falls back to electron-updater when the pending record is unavailable", async () => {
    const { controller, quit } = createController();
    fakeInstallPendingUpdate.mockReturnValue(false);
    fakeUpdater.emit("update-downloaded", {
      version: "0.2.0",
      downloadedFile: "C:\\cache\\Answra-Setup.exe",
    });

    expect(await controller.installNow()).toEqual({ started: true });
    expect(fakeUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(quit).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("installs through quitAndInstall on Linux", async () => {
    const { controller } = createController({ platform: "freebsd" });
    fakeUpdater.emit("update-downloaded", {
      version: "0.2.0",
      downloadedFile: "/cache/Answra.AppImage",
    });

    expect(await controller.installNow()).toEqual({ started: true });
    expect(fakeUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
    controller.dispose();
  });

  it("refuses immediate install when no update has been downloaded", async () => {
    const { controller, quit } = createController();

    expect(await controller.installNow()).toEqual({ started: false });
    expect(fakeInstallPendingUpdate).not.toHaveBeenCalled();
    expect(fakeUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("pushes status changes to subscribers", () => {
    const { controller } = createController();
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);

    fakeUpdater.emit("checking-for-update");
    fakeUpdater.emit("update-available", { version: "0.2.0" });
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "available", availableVersion: "0.2.0" }),
    );

    const callsBeforeUnsubscribe = listener.mock.calls.length;
    unsubscribe();
    fakeUpdater.emit("download-progress", { percent: 10, transferred: 1, total: 10 });
    expect(listener).toHaveBeenCalledTimes(callsBeforeUnsubscribe);
    controller.dispose();
  });
});

function fakeSwapInstaller() {
  return {
    extracted: [] as string[],
    installed: [] as string[],
    extract: vi.fn(async function (zipPath: string) {
      this.extracted.push(zipPath);
      return "/updates/Answra.app";
    }),
    startInstall: vi.fn(async function (appPath: string) {
      this.installed.push(appPath);
    }),
  };
}
