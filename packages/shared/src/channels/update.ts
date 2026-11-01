/**
 * 应用更新频道：手动检查、下载重试与立即安装。
 *
 * 更新状态只由 main 进程的 updateController 持有；渲染层通过 `UpdateStatus`
 * 镜像展示，不根据版本号自行推算“是否有更新”。
 */
export const UpdateChannels = {
  /** 读取当前更新状态；包含当前版本号，供设置页展示。 */
  GetStatus: "answra:update:get-status",
  /** 手动检查更新；发现新版本后等待用户点击「下载更新」。 */
  Check: "answra:update:check",
  /** 下载新版本（点击触发，也可用于失败后重试）。 */
  Download: "answra:update:download",
  /** 立即重启并安装已下载的更新。 */
  InstallNow: "answra:update:install-now",
  /** main 进程推送更新状态变化。 */
  Status: "answra:update:status",
} as const;

/**
 * 更新流程所处阶段。
 *
 * - `unsupported`：开发态或当前平台不支持自动更新；
 * - `idle`：尚未检查；
 * - `checking`：正在向更新源查询；
 * - `up-to-date`：已是最新版本；
 * - `available`：发现新版本（自动下载开启时通常是瞬时态；手动安装模式下会停留在此）；
 * - `downloading`：正在下载；
 * - `downloaded`：已下载，等待下次启动或用户立即安装；
 * - `error`：检查或下载失败，可按 `availableVersion` 决定重试方式。
 */
export type UpdatePhase =
  | "unsupported"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

/**
 * 用户不主动点击「立即重启安装」时，更新最终如何安装。
 *
 * - `next-launch`：Windows，写待安装记录，下次启动安装；
 * - `auto-swap`：macOS 未签名构建，下载完成后由自研换装脚本替换应用并重启；
 *   Squirrel.Mac 校验 Apple 签名导致官方换装不可用；
 * - `on-quit`：其余可交给 electron-updater 退出时安装的平台。
 */
export type UpdateInstallMode = "next-launch" | "auto-swap" | "on-quit";

export interface UpdateProgress {
  /** 0-100。 */
  percent: number;
  transferred: number;
  total: number;
}

export interface UpdateStatus {
  phase: UpdatePhase;
  currentVersion: string;
  /** 已发现/已下载的目标版本；没有候选版本为 null。 */
  availableVersion: string | null;
  progress: UpdateProgress | null;
  /** 面向用户的一句话错误；自动检查失败时为 null（只记日志）。 */
  error: string | null;
  installMode: UpdateInstallMode;
  /** 换装就绪时的新版本安装载体路径（Windows 安装包 / 换出的 macOS .app）；未就绪为 null。 */
  downloadedPath: string | null;
  /** 最近一次检查完成时间（ISO 字符串）；尚未检查为 null。 */
  lastCheckedAt: string | null;
}

/** 立即安装结果；`started=false` 表示安装器未能启动，应用仍在运行。 */
export interface UpdateInstallResult {
  started: boolean;
}

export interface UpdateChannelMap {
  [UpdateChannels.GetStatus]: { request: undefined; response: UpdateStatus };
  [UpdateChannels.Check]: { request: undefined; response: UpdateStatus };
  [UpdateChannels.Download]: { request: undefined; response: UpdateStatus };
  [UpdateChannels.InstallNow]: { request: undefined; response: UpdateInstallResult };
  [UpdateChannels.Status]: { request: undefined; response: undefined };
}
