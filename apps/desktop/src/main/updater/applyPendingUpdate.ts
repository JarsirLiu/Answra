/**
 * 待安装更新的安装器拉起（仅 Windows）。
 *
 * 启动时安装由 `applyPendingUpdateOnLaunch` 消费记录并退出；设置页「立即重启安装」
 * 由 updateController 复用 `installPendingUpdate`，避免两套安装路径漂移。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  clearPendingUpdate,
  isNewerVersion,
  pendingUpdateMarkerPath,
  readPendingUpdate,
} from "./pendingUpdate";

/** 与 electron-updater 的 NsisUpdater 保持一致：静默安装并在结束后重开应用。 */
const NSIS_INSTALL_ARGS = ["--updated", "/S", "--force-run"];

export interface InstallPendingUpdateOptions {
  configDir: string;
  currentVersion: string;
  platform?: NodeJS.Platform;
  isFile?: (path: string) => boolean;
  spawnInstaller?: (installerPath: string) => boolean;
  log?: (message: string, error?: unknown) => void;
}

export interface ApplyPendingUpdateOptions extends InstallPendingUpdateOptions {
  /** 安装器成功拉起后调用方应停止启动流程（安装器会重开应用）。 */
  quit: () => void;
}

/**
 * 校验待安装记录并拉起安装器。返回 true 表示安装器已启动，调用方负责退出应用；
 * 记录不新、安装包缺失或拉起失败时返回 false。
 */
export function installPendingUpdate(options: InstallPendingUpdateOptions): boolean {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return false;

  const log = options.log ?? ((message, error) => console.warn(message, error ?? ""));
  const markerPath = pendingUpdateMarkerPath(options.configDir);
  const pending = readPendingUpdate(markerPath);
  if (!pending) return false;

  const isFile = options.isFile ?? existsSync;
  if (!isNewerVersion(pending.version, options.currentVersion) || !isFile(pending.installerPath)) {
    clearPendingUpdate(markerPath);
    return false;
  }

  const spawnInstaller = options.spawnInstaller ?? spawnDetachedInstaller;
  if (!spawnInstaller(pending.installerPath)) {
    // 记录保留到下次启动再试；本次照常启动，不影响用户使用当前版本。
    log("[updater] 无法启动待安装的更新，保持当前版本并在下次启动重试");
    return false;
  }

  // 先清除再退出：安装若再次被打断，后台检查会重新下载并写回记录，避免每次启动都重启。
  clearPendingUpdate(markerPath);
  return true;
}

/** 启动时安装：成功拉起安装器后立即退出，安装器结束后重开新版本。 */
export function applyPendingUpdateOnLaunch(options: ApplyPendingUpdateOptions): boolean {
  if (!installPendingUpdate(options)) return false;
  options.quit();
  return true;
}

function spawnDetachedInstaller(installerPath: string): boolean {
  try {
    const child = spawn(installerPath, NSIS_INSTALL_ARGS, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", (error) => console.warn("[updater] 安装器进程启动失败", error));
    child.unref();
    return true;
  } catch (error) {
    console.warn("[updater] 无法创建安装器进程", error);
    return false;
  }
}
