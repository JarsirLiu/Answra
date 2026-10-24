import { autoUpdater } from "electron-updater";

/** 启动后延迟首查，之后每 4 小时轮询一次。 */
const STARTUP_DELAY_MS = 5_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

interface UpdateControllerOptions {
  /** 仅打包态启用；开发态（pnpm dev）没有 app-update.yml，检查必然报错。 */
  isPackaged: boolean;
  platform?: NodeJS.Platform;
  log?: (message: string, error?: unknown) => void;
}

export interface UpdateController {
  dispose(): void;
}

/**
 * 静默自动更新：后台检查 → 自动下载 → 退出时安装（autoInstallOnAppQuit 默认行为）。
 * 更新源来自 electron-builder 的 publish 配置，打包时写入 app-update.yml，这里无需再设。
 */
export function createUpdateController({
  isPackaged,
  platform = process.platform,
  log = (message, error) => console.log(message, error ?? ""),
}: UpdateControllerOptions): UpdateController {
  if (!isPackaged || platform === "linux") {
    return { dispose: () => undefined };
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (message) => log(`[updater] ${String(message)}`),
    warn: (message) => log(`[updater] ${String(message)}`),
    error: (message) => log(`[updater] ${String(message)}`),
    debug: undefined,
  };

  autoUpdater.on("update-downloaded", () => {
    log("[updater] 新版本已下载，退出应用后自动安装");
  });

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
