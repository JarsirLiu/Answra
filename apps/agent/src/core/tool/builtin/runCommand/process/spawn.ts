/**
 * 统一的 shell 子进程创建：一次性命令与会话共用 spawn、shell 调用和平台 containment。
 * 不负责输出收集、会话状态或终止策略。
 */

import { type ChildProcess, spawn } from "node:child_process";
import { buildShellInvocation, type ShellSyntax } from "../shell/runtime";
import { createProcessContainment } from "./containment";

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
  const containment = createProcessContainment();
  const invocation = buildShellInvocation(options.command, {
    ...(containment.shellBootstrap && { windowsBootstrap: containment.shellBootstrap }),
  });
  const child = spawn(invocation.executable, invocation.args, {
    cwd: options.cwd,
    stdio: [options.stdin, "pipe", "pipe"],
    ...containment.spawnOptions(),
  });
  return {
    child,
    ...(containment.jobMarkerPath && { jobMarkerPath: containment.jobMarkerPath }),
    shellSyntax: invocation.syntax,
  };
}
