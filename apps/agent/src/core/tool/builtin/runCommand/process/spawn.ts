/**
 * 统一的 shell 子进程创建：一次性命令与会话共用 spawn、shell 调用和 Windows Job Object 引导。
 * 不负责输出收集、会话状态或终止策略。
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildShellInvocation, type ShellSyntax } from "../shell/runtime";
import { buildWindowsJobBootstrap, JOB_MARKER_ENV } from "./processTree";

export interface SpawnShellProcessOptions {
  readonly command: string;
  readonly cwd: string;
  readonly stdin: "ignore" | "pipe";
}

export interface ShellProcessHandle {
  readonly child: ChildProcess;
  readonly jobMarkerPath?: string;
  readonly shellSyntax: ShellSyntax;
}

export function spawnShellProcess(options: SpawnShellProcessOptions): ShellProcessHandle {
  const windows = process.platform === "win32";
  const jobMarkerPath = windows
    ? path.join(os.tmpdir(), `answra-shell-job-${randomUUID()}.marker`)
    : undefined;
  const invocation = buildShellInvocation(
    options.command,
    windows ? { windowsBootstrap: buildWindowsJobBootstrap() } : {},
  );
  const child = spawn(invocation.executable, invocation.args, {
    cwd: options.cwd,
    windowsHide: true,
    detached: !windows,
    stdio: [options.stdin, "pipe", "pipe"],
    ...(jobMarkerPath && { env: { ...process.env, [JOB_MARKER_ENV]: jobMarkerPath } }),
  });
  return {
    child,
    ...(jobMarkerPath && { jobMarkerPath }),
    shellSyntax: invocation.syntax,
  };
}

export async function removeShellJobMarker(jobMarkerPath?: string): Promise<void> {
  if (!jobMarkerPath) return;
  await rm(jobMarkerPath, { force: true }).catch(() => undefined);
}
