/**
 * Shell 进程创建与终止的跨平台工厂；平台分支只在这里和 windows/posix 后端内。
 * 不负责 shell 调用构造、输出收集或会话状态。
 */

import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createPosixContainment, terminatePosixProcessTree } from "./posix";
import { createWindowsContainment, removeJobMarker, terminateWindowsProcessTree } from "./windows";

export interface ProcessContainment {
  readonly kind: "job-object" | "process-group";
  readonly shellBootstrap?: string;
  readonly jobMarkerPath?: string;
  spawnOptions(): Pick<SpawnOptions, "detached" | "env" | "windowsHide">;
}

export function createProcessContainment(
  platform: NodeJS.Platform = process.platform,
): ProcessContainment {
  return platform === "win32" ? createWindowsContainment() : createPosixContainment();
}

export function terminateProcessTree(child: ChildProcess, jobMarkerPath?: string): Promise<void> {
  if (process.platform === "win32") return terminateWindowsProcessTree(child, jobMarkerPath);
  return terminatePosixProcessTree(child);
}

export function removeShellJobMarker(jobMarkerPath?: string): Promise<void> {
  return removeJobMarker(jobMarkerPath);
}
