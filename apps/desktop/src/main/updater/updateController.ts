import { autoUpdater } from "electron-updater";
import { pendingUpdateMarkerPath, writePendingUpdate } from "./pendingUpdate";

/** 启动后延迟首查，之后每 4 小时轮询一次。 */
const STARTUP_DELAY_MS = 5_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

interface UpdateControllerOptions {
  /** 仅打包态启用；开发态（pnpm dev）没有 app-update.yml，检查必然报错。 */
  isPackaged: boolean;
  /** userData 目录：Windows 下用来持久化“下次启动安装”的记录。 */
  configDir: string;
  platform?: NodeJS.Platform;
  log?: (message: string, error?: unknown) => void;
}

export interface UpdateController {
  dispose(): void;
}

/**
 * 静默自动更新：后台检查 → 自动下载 → 安装。
 *
 * Windows 不在退出时安装（避免“关闭后立刻关机”打断 NSIS 覆盖写），
 * 只写一条待安装记录，由下次启动的 `applyPendingUpdateOnLaunch` 消费；
 * 其他平台沿用 electron-updater 的退出时自动安装。
 */
export function createUpdateController({
  isPackaged,
  configDir,
  platform = process.platform,
  log = (message, error) => console.log(message, error ?? ""),
}: UpdateControllerOptions): UpdateController {
  if (!isPackaged || platform === "linux") {
    return { dispose: () => undefined };
  }

  const deferInstallToLaunch = platform === "win32";
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = !deferInstallToLaunch;
  autoUpdater.logger = {
    info: (message) => log(`[updater] ${String(message)}`),
    warn: (message) => log(`[updater] ${String(message)}`),
    error: (message) => log(`[updater] ${String(message)}`),
    debug: undefined,
  };

  if (deferInstallToLaunch) {
    const markerPath = pendingUpdateMarkerPath(configDir);
    autoUpdater.on("update-downloaded", (event) => {
      try {
        writePendingUpdate(markerPath, {
          version: event.version,
          installerPath: event.downloadedFile,
        });
        log(`[updater] 版本 ${event.version} 已下载，将在下次启动时安装`);
      } catch (error) {
        // 记录失败就无法再推迟：回退为退出时安装，避免更新永久卡住。
        autoUpdater.autoInstallOnAppQuit = true;
        log("[updater] 无法记录待安装更新，回退为退出时安装", error);
      }
    });
  } else {
    autoUpdater.on("update-downloaded", () => {
      log("[updater] 新版本已下载，退出应用后自动安装");
    });
  }

  const check = () =>
    autoUpdater.checkForUpdates().catch((error) => {
      // 更新源不可达（离线/域名问题）不该打扰用户，只记日志、等下一轮。
      log("[updater] 检查更新失败", error);
    });

  const startupTimer = setTimeout(() => void check(), STARTUP_DELAY_MS);
  const intervalTimer = setInterval(() => void check(), CHECK_INTERVAL_MS);

  return {
    dispose() {
      clearTimeout(startupTimer);
      clearInterval(intervalTimer);
      autoUpdater.removeAllListeners();
    },
  };
}
