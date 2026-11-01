/**
 * 更新控制器：main 进程里唯一持有更新状态的地方。
 *
 * 后台按 5s 首查 / 4h 轮询自动检查并下载；设置页通过 updateIpc 读取状态、
 * 手动触发检查或重试下载、立即重启安装。Windows 下载完成后只写待安装记录，
 * 真正的安装仍推迟到下次启动，避免关机打断 NSIS 覆盖写。
 */

import type { UpdateInstallMode, UpdateInstallResult, UpdateStatus } from "@answra/shared";
import { autoUpdater } from "electron-updater";
import { installPendingUpdate } from "./applyPendingUpdate";
import { pendingUpdateMarkerPath, writePendingUpdate } from "./pendingUpdate";
import {
  INITIAL_UPDATE_STATE,
  reduceUpdateState,
  type UpdateMachineEvent,
  type UpdateMachineState,
} from "./updateState";

/** 启动后延迟首查，之后每 4 小时轮询一次。 */
const STARTUP_DELAY_MS = 5_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const CHECK_FAILED_MESSAGE = "无法连接更新服务器，请稍后重试";
const DOWNLOAD_FAILED_MESSAGE = "更新下载失败，请重试";
/** 进度推送节流：进度至少变化 1% 或距上次推送满 250ms 才发 IPC。 */
const PROGRESS_NOTIFY_STEP = 1;
const PROGRESS_NOTIFY_INTERVAL_MS = 250;

interface UpdateControllerOptions {
  /** 仅打包态启用；开发态（pnpm dev）没有 app-update.yml，检查必然报错。 */
  isPackaged: boolean;
  /** 当前安装版本，由组合根传 `app.getVersion()`。 */
  currentVersion: string;
  /** userData 目录：Windows 下用来持久化“下次启动安装”的记录。 */
  configDir: string;
  /** 安装器成功拉起后退出应用。 */
  quit: () => void;
  platform?: NodeJS.Platform;
  log?: (message: string, error?: unknown) => void;
}

export interface UpdateController {
  getStatus(): UpdateStatus;
  /** 手动或定时检查；并发调用共享同一轮结果，不会重复发起。 */
  check(options?: { manual?: boolean }): Promise<UpdateStatus>;
  /** 下载失败后重试。 */
  download(): Promise<UpdateStatus>;
  /** 立即重启并安装已下载的更新。 */
  installNow(): Promise<UpdateInstallResult>;
  subscribe(listener: (status: UpdateStatus) => void): () => void;
  dispose(): void;
}

/**
 * 创建更新控制器。开发态与 Linux 返回 `unsupported` 状态，
 * 但仍响应状态查询，让设置页能展示版本号。
 */
export function createUpdateController(options: UpdateControllerOptions): UpdateController {
  const platform = options.platform ?? process.platform;
  const log = options.log ?? ((message, error) => console.log(message, error ?? ""));
  const supported = options.isPackaged && platform !== "linux";
  let installMode: UpdateInstallMode = platform === "win32" ? "next-launch" : "on-quit";
  let machine: UpdateMachineState = supported
    ? INITIAL_UPDATE_STATE
    : { ...INITIAL_UPDATE_STATE, phase: "unsupported" };
  let lastCheckedAt: string | null = null;
  const listeners = new Set<(status: UpdateStatus) => void>();
  let checkInFlight = false;
  let manualCheck = false;
  let installing = false;
  let lastProgressPercent = -1;
  let lastProgressAt = 0;

  const statusOf = (): UpdateStatus => ({
    ...machine,
    currentVersion: options.currentVersion,
    installMode,
    lastCheckedAt,
  });
  let status = statusOf();

  const publish = (): void => {
    for (const listener of [...listeners]) listener(status);
  };
  const reduce = (event: UpdateMachineEvent): void => {
    machine = reduceUpdateState(machine, event);
    status = statusOf();
  };
  const apply = (event: UpdateMachineEvent): void => {
    reduce(event);
    publish();
  };
  const now = (): string => new Date().toISOString();
  const finishFailure = (message: string | null): void => {
    if (
      machine.phase !== "checking" &&
      machine.phase !== "available" &&
      machine.phase !== "downloading"
    ) {
      return;
    }
    lastCheckedAt = now();
    apply({ type: "failed", message });
  };

  if (!supported) {
    return {
      getStatus: () => status,
      check: async () => status,
      download: async () => status,
      installNow: async () => ({ started: false }),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      dispose: () => undefined,
    };
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

  const markerPath = pendingUpdateMarkerPath(options.configDir);
  autoUpdater.on("checking-for-update", () => apply({ type: "check-started" }));
  autoUpdater.on("update-available", (info) => {
    lastCheckedAt = now();
    apply({ type: "check-finished", availableVersion: info.version });
  });
  autoUpdater.on("update-not-available", () => {
    lastCheckedAt = now();
    apply({ type: "check-finished", availableVersion: null });
  });
  autoUpdater.on("download-progress", (progress) => {
    const percent = clampPercent(progress.percent);
    reduce({
      type: "download-progress",
      progress: {
        percent,
        transferred: progress.transferred,
        total: progress.total,
      },
    });
    const nowMs = Date.now();
    if (
      percent - lastProgressPercent >= PROGRESS_NOTIFY_STEP ||
      nowMs - lastProgressAt >= PROGRESS_NOTIFY_INTERVAL_MS
    ) {
      lastProgressPercent = percent;
      lastProgressAt = nowMs;
      publish();
    }
  });
  autoUpdater.on("update-downloaded", (event) => {
    if (deferInstallToLaunch) {
      try {
        writePendingUpdate(markerPath, {
          version: event.version,
          installerPath: event.downloadedFile,
        });
        log(`[updater] 版本 ${event.version} 已下载，将在下次启动时安装`);
      } catch (error) {
        // 记录失败就无法再推迟：回退为退出时安装，避免更新永久卡住。
        autoUpdater.autoInstallOnAppQuit = true;
        installMode = "on-quit";
        log("[updater] 无法记录待安装更新，回退为退出时安装", error);
      }
    } else {
      log(`[updater] 版本 ${event.version} 已下载，退出应用后自动安装`);
    }
    apply({ type: "downloaded", version: event.version });
  });
  autoUpdater.on("error", (error) => {
    log("[updater] 更新失败", error);
    const duringDownload =
      machine.phase === "downloading" ||
      (machine.phase === "available" && machine.availableVersion !== null);
    finishFailure(
      duringDownload ? DOWNLOAD_FAILED_MESSAGE : manualCheck ? CHECK_FAILED_MESSAGE : null,
    );
  });

  async function check({ manual = false }: { manual?: boolean } = {}): Promise<UpdateStatus> {
    if (checkInFlight) {
      if (manual) manualCheck = true;
      return status;
    }
    if (
      machine.phase === "checking" ||
      machine.phase === "available" ||
      machine.phase === "downloading" ||
      machine.phase === "downloaded"
    ) {
      return status;
    }
    checkInFlight = true;
    manualCheck = manual;
    apply({ type: "check-started" });
    try {
      const result = await autoUpdater.checkForUpdates();
      // 正常路径由 update-available / update-not-available 事件收敛；
      // 事件缺失时用返回值兜底，避免界面永远停在“正在检查”。状态机只接受
      // checking 阶段的 check-finished，事件已先行收敛时这次调用会被忽略。
      lastCheckedAt = now();
      apply({
        type: "check-finished",
        availableVersion: result?.updateInfo.version ?? null,
      });
    } catch (error) {
      log("[updater] 检查更新失败", error);
      finishFailure(manualCheck ? CHECK_FAILED_MESSAGE : null);
    } finally {
      checkInFlight = false;
      manualCheck = false;
    }
    return status;
  }

  async function download(): Promise<UpdateStatus> {
    if (machine.phase !== "available" && machine.phase !== "error") return status;
    if (!machine.availableVersion) return status;
    // 重试从 0 开始：清掉上一轮进度节流凭据，保证首个进度事件可见。
    lastProgressPercent = -1;
    lastProgressAt = 0;
    apply({ type: "download-started" });
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      log("[updater] 下载更新失败", error);
      finishFailure(DOWNLOAD_FAILED_MESSAGE);
    }
    return status;
  }

  async function installNow(): Promise<UpdateInstallResult> {
    if (machine.phase !== "downloaded" || installing) return { started: false };
    installing = true;
    try {
      if (platform === "win32") {
        const started = installPendingUpdate({
          configDir: options.configDir,
          currentVersion: options.currentVersion,
          platform,
          log,
        });
        if (started) {
          options.quit();
          return { started: true };
        }
        log("[updater] 待安装记录不可用，回退 electron-updater 立即安装");
      }
      autoUpdater.quitAndInstall(false, true);
      return { started: true };
    } catch (error) {
      log("[updater] 立即安装失败", error);
      return { started: false };
    } finally {
      installing = false;
    }
  }

  const startupTimer = setTimeout(() => void check(), STARTUP_DELAY_MS);
  const intervalTimer = setInterval(() => void check(), CHECK_INTERVAL_MS);

  return {
    getStatus: () => status,
    check: (checkOptions) => check(checkOptions),
    download,
    installNow,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      clearTimeout(startupTimer);
      clearInterval(intervalTimer);
      autoUpdater.removeAllListeners();
      listeners.clear();
    },
  };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}
