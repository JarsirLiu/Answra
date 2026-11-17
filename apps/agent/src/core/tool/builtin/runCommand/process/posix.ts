/**
 * POSIX shell 进程组 termination：SIGTERM → 探活 → SIGKILL 阶段升级。
 * 不负责 shell 构造、输出收集或会话状态。
 */

import type { ChildProcess, SpawnOptions } from "node:child_process";
import { delay } from "./delay";

const CONTAINMENT_PROBE_INTERVAL_MS = 50;
const POSIX_TERM_WAIT_MS = 2_000;
const POSIX_KILL_WAIT_MS = 5_000;

export interface PosixContainment {
  readonly kind: "process-group";
  spawnOptions(): Pick<SpawnOptions, "detached" | "windowsHide">;
}

export function createPosixContainment(): PosixContainment {
  return {
    kind: "process-group",
    spawnOptions: () => ({ detached: true, windowsHide: true }),
  };
}

export async function terminatePosixProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) return;

  signalPosixProcessGroup(pid, "SIGTERM", child);
  if (await waitForPosixProcessGroupExit(pid, POSIX_TERM_WAIT_MS)) return;

  signalPosixProcessGroup(pid, "SIGKILL", child);
  await waitForPosixProcessGroupExit(pid, POSIX_KILL_WAIT_MS);
}

function signalPosixProcessGroup(pid: number, signal: NodeJS.Signals, child: ChildProcess): void {
  try {
    process.kill(-pid, signal);
  } catch (error: unknown) {
    if (isMissingProcessError(error)) return;
    child.kill(signal);
  }
}

async function waitForPosixProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isPosixProcessGroupAlive(pid)) return true;
    if (Date.now() >= deadline) return !isPosixProcessGroupAlive(pid);
    await delay(CONTAINMENT_PROBE_INTERVAL_MS);
  }
}

function isPosixProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error: unknown) {
    return !isMissingProcessError(error);
  }
}

function isMissingProcessError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH"
  );
}
