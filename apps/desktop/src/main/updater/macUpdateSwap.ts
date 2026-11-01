/**
 * macOS 自动换装：官方更新 zip → `ditto` 解出 `.app` → 换装脚本替换并重启。
 *
 * Squirrel.Mac 校验 Apple 签名导致未签名构建无法自装，这里只用系统工具完成
 * 本地文件搬移：旧 `.app` 先挪到同级 `.old`（同卷 mv 原子），新版挪进原位，
 * 失败还原，最后重新拉起应用。脚本内容见 `macSwapScript`（纯函数，可单测）。
 */

import { execFile, spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { MacSwapInstaller } from "./updateController";

const execFileAsync = promisify(execFile);
/** 换装脚本等待旧进程退出的上限（秒）；超时照常尝试替换。 */
const QUIT_WAIT_SECONDS = 30;

interface MacSwapOptions {
  /** 当前应用的 `process.execPath`（位于旧 `.app` 内），用于反推旧应用目录。 */
  execPath: string;
  /** 存放换装脚本与解出 `.app` 的目录（userData 下）。 */
  swapDir: string;
  /** 换装脚本落盘路径。 */
  scriptPath: string;
  log?: (message: string, error?: unknown) => void;
}

export function createMacSwapInstaller(options: MacSwapOptions): MacSwapInstaller {
  const log = options.log ?? ((message, error) => console.log(message, error ?? ""));
  const runningAppPath = extractAppPath(options.execPath);
  if (!runningAppPath) {
    throw new Error(`无法从可执行文件路径推断应用目录：${options.execPath}`);
  }
  const newAppPath = path.join(options.swapDir, path.basename(runningAppPath));

  return {
    async extract(zipPath: string): Promise<string> {
      await mkdir(options.swapDir, { recursive: true });
      // 清掉上一次的解压残留，保证 `newAppPath` 只来自本次下载的 zip。
      await rm(newAppPath, { recursive: true, force: true });
      await execFileAsync("ditto", ["-x", "-k", zipPath, options.swapDir]);
      return newAppPath;
    },
    startInstall(appPath: string): void {
      void startSwap(options.scriptPath, macSwapScript(runningAppPath, appPath), log);
    },
  };
}

/** 从 `…/Answra.app/Contents/MacOS/<binary>` 反推出 `…/Answra.app`。 */
export function extractAppPath(execPath: string): string | null {
  const contents = path.dirname(path.dirname(execPath));
  if (path.basename(contents) !== "Contents") return null;
  return path.dirname(contents);
}

/** 生成换装脚本：等待退出 → 备份换装 → 失败还原 → 重启。 */
export function macSwapScript(appPath: string, newAppPath: string): string {
  const oldPath = `${appPath}.old`;
  return [
    "#!/bin/sh",
    "# 未签名 macOS 自动换装：等旧进程退出后原子替换应用目录并重启。",
    "set -u",
    `RUNNING_MARK="${appPath}/Contents/MacOS/"`,
    `APP="${appPath}"`,
    `NEW="${newAppPath}"`,
    `OLD="${oldPath}"`,
    'rm -rf "$OLD"',
    `for i in $(seq 1 ${QUIT_WAIT_SECONDS}); do`,
    '  pgrep -f "$RUNNING_MARK" >/dev/null || break',
    "  sleep 1",
    "done",
    'if ! mv "$APP" "$OLD" || ! mv "$NEW" "$APP"; then',
    '  mv "$OLD" "$APP" 2>/dev/null || true',
    "  exit 1",
    "fi",
    'rm -rf "$OLD"',
    'open "$APP"',
    "",
  ].join("\n");
}

async function startSwap(
  scriptPath: string,
  script: string,
  log: (message: string, error?: unknown) => void,
): Promise<void> {
  try {
    await writeFile(scriptPath, script, { mode: 0o700 });
    const child = spawn("/bin/sh", [scriptPath], { detached: true, stdio: "ignore" });
    child.unref();
  } catch (error) {
    log("[updater] 换装脚本无法落地，保持当前版本运行", error);
  }
}
