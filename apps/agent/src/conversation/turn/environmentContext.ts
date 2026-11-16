/** 通用对话的运行环境事实；只描述平台、OS 和实际 shell，不承载工具能力或时间。 */
import os from "node:os";
import { describeShellSyntax, resolveShellRuntime, type ShellRuntime } from "../../core/tool";

export interface RuntimeEnvironment {
  readonly platform: NodeJS.Platform;
  readonly release: string;
  readonly arch: string;
  readonly shell: ShellRuntime;
}

const PLATFORM_LABELS: Partial<Record<NodeJS.Platform, string>> = {
  win32: "Windows",
  darwin: "macOS",
  linux: "Linux",
};

export function readRuntimeEnvironment(): RuntimeEnvironment {
  return {
    platform: process.platform,
    release: os.release(),
    arch: os.arch(),
    shell: resolveShellRuntime(),
  };
}

export function buildEnvironmentSystemContext(environment: RuntimeEnvironment): string {
  const platform = PLATFORM_LABELS[environment.platform] ?? environment.platform;
  return [
    "# 运行环境",
    `- 操作系统：${platform}（${environment.platform} ${environment.release} ${environment.arch}）。`,
    `- Shell：${environment.shell.displayName}`,
    `- 命令语法：${describeShellSyntax(environment.shell)}`,
  ].join("\n");
}
