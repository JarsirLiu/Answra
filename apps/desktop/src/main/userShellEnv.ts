/**
 * 注入用户登录 shell 的环境变量。
 *
 * macOS/Linux 从 Finder/Dock 启动时继承的是 launchd 的最小 PATH，
 * Agent worker 里 spawn 的 `$SHELL -c` 会找不到 Homebrew、nvm 等用户命令。
 * 启动时用登录 shell 探测一次完整环境并写回主进程 env，utility process 再继承。
 */

import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { basename } from "node:path";

const PROBE_TIMEOUT_MS = 5_000;
const FALLBACK_SHELL = "/bin/sh";

export type ShellEnvSource = "interactive" | "login";

export interface ShellEnvProbeOptions {
  readonly timeout: number;
  readonly windowsHide: boolean;
}

export interface ShellEnvProbeResult {
  readonly status: number | null;
  readonly stdout?: Buffer | string;
  readonly error?: { readonly code?: string } | undefined;
}

export type ShellEnvSpawn = (
  file: string,
  args: readonly string[],
  options: ShellEnvProbeOptions,
) => ShellEnvProbeResult;

export interface LoadUserShellEnvOptions {
  readonly platform?: NodeJS.Platform;
  readonly envShell?: string;
  readonly loginShell?: string | null;
  readonly spawn?: ShellEnvSpawn;
}

export type UserShellEnvResult =
  | {
      readonly status: "loaded";
      readonly shell: string;
      readonly source: ShellEnvSource;
      readonly variables: Record<string, string>;
    }
  | {
      readonly status: "skipped";
      readonly reason: "windows" | "nushell" | "probe-timeout" | "unavailable";
    };

type ProbeOutcome =
  | { readonly type: "loaded"; readonly env: Record<string, string> }
  | { readonly type: "timeout" }
  | { readonly type: "unavailable" };

export function resolveUserShell(
  envShell: string | undefined,
  loginShell: string | null | undefined,
): string {
  if (envShell) return envShell;
  if (loginShell) return loginShell;
  return FALLBACK_SHELL;
}

export function parseShellEnv(output: Buffer | string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of output.toString().split("\0")) {
    if (!entry) continue;
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    env[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return env;
}

export function loadUserShellEnv(options: LoadUserShellEnvOptions = {}): UserShellEnvResult {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return { status: "skipped", reason: "windows" };

  const shell = resolveUserShell(
    options.envShell === undefined ? process.env.SHELL : options.envShell,
    options.loginShell === undefined ? readLoginShell() : options.loginShell,
  );
  if (isNushell(shell)) return { status: "skipped", reason: "nushell" };

  const spawn = options.spawn ?? defaultSpawn;
  const interactive = probeShellEnv(shell, "-il", spawn);
  if (interactive.type === "loaded") {
    return { status: "loaded", shell, source: "interactive", variables: interactive.env };
  }
  if (interactive.type === "timeout") return { status: "skipped", reason: "probe-timeout" };

  const login = probeShellEnv(shell, "-l", spawn);
  if (login.type === "loaded") {
    return { status: "loaded", shell, source: "login", variables: login.env };
  }
  return { status: "skipped", reason: "unavailable" };
}

export function applyUserShellEnv(
  env: NodeJS.ProcessEnv,
  options: LoadUserShellEnvOptions = {},
): UserShellEnvResult {
  const result = loadUserShellEnv(options);
  if (result.status === "loaded") Object.assign(env, result.variables);
  return result;
}

function readLoginShell(): string | undefined {
  try {
    const shell = userInfo().shell;
    return shell && shell !== "unknown" ? shell : undefined;
  } catch {
    return undefined;
  }
}

function isNushell(shell: string): boolean {
  const name = basename(shell).toLowerCase();
  return name === "nu" || name === "nu.exe";
}

const defaultSpawn: ShellEnvSpawn = (file, args, options) => {
  const result = spawnSync(file, [...args], {
    stdio: ["ignore", "pipe", "ignore"],
    timeout: options.timeout,
    windowsHide: options.windowsHide,
  });
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  return {
    status: result.status,
    stdout: result.stdout,
    ...(code === undefined ? {} : { error: { code } }),
  };
};

function probeShellEnv(shell: string, mode: "-il" | "-l", spawn: ShellEnvSpawn): ProbeOutcome {
  const result = spawn(shell, [mode, "-c", "env -0"], {
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error?.code === "ETIMEDOUT") return { type: "timeout" };
  if (result.error || result.status !== 0) return { type: "unavailable" };

  const env = parseShellEnv(result.stdout ?? "");
  return Object.keys(env).length > 0 ? { type: "loaded", env } : { type: "unavailable" };
}
