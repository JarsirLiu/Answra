/**
 * Shell 进程的跨平台调用构造与 shell 选择；输出解码、截断和错误清理在 output.ts。
 * 一次性命令与会话命令共用这里，避免两条路径的 shell 语义再次漂移。
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { POWERSHELL_ECHO_START, POWERSHELL_EXIT_CODE_TRAILER } from "./output";

const POWERSHELL_5_EXECUTABLE = "powershell.exe";
const POWERSHELL_5_DISPLAY_NAME = "Windows PowerShell 5.1 (powershell.exe)";
const POWERSHELL_7_DISPLAY_NAME = "PowerShell 7+ (pwsh)";
const CMD_DISPLAY_NAME = "cmd.exe";

const POWERSHELL_PREFIX = [
  POWERSHELL_ECHO_START,
  "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
  "$OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
  // Windows PowerShell 5.1 otherwise reads text files with the system code page.
  "$PSDefaultParameterValues['Get-Content:Encoding'] = 'utf8'",
].join("\n");

export type ShellKind = "bash" | "zsh" | "sh" | "dash" | "ksh" | "pwsh" | "powershell" | "cmd";

export type ShellSyntax = "posix" | "powershell" | "cmd";

export interface ShellRuntime {
  readonly executable: string;
  readonly displayName: string;
  readonly kind: ShellKind;
  readonly syntax: ShellSyntax;
}

export interface ShellRuntimeOptions {
  readonly platform?: NodeJS.Platform;
  readonly shell?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** 测试注入；返回可执行文件路径，未找到时返回 undefined。 */
  readonly findExecutable?: (name: string) => string | undefined;
}

export interface ShellInvocation extends ShellRuntime {
  readonly args: readonly string[];
}

export interface ShellInvocationOptions extends ShellRuntimeOptions {
  readonly windowsBootstrap?: string;
}

const POSIX_SHELLS = new Set(["bash", "zsh", "sh", "dash", "ksh"]);

export function resolveShellRuntime(options: ShellRuntimeOptions = {}): ShellRuntime {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  // 只检测 Windows 的 powershell/pwsh；POSIX 的 shell 由 SHELL 或固定兜底决定。
  const findExecutable =
    options.findExecutable ?? ((name: string) => findWindowsExecutable(name, env));

  if (platform === "win32") return resolveWindowsShell(options.shell, env, findExecutable);
  return resolvePosixShell(options.shell ?? env.SHELL, platform);
}

function resolveWindowsShell(
  configured: string | undefined,
  env: NodeJS.ProcessEnv,
  findExecutable: (name: string) => string | undefined,
): ShellRuntime {
  const explicit = normalizeWindowsShell(configured, env, findExecutable);
  if (explicit) return explicit;

  const pwsh = findExecutable("pwsh") ?? findExecutable("pwsh.exe");
  if (pwsh) return powershellRuntime("pwsh", pwsh);
  return powershellRuntime("powershell", POWERSHELL_5_EXECUTABLE);
}

function normalizeWindowsShell(
  value: string | undefined,
  env: NodeJS.ProcessEnv,
  findExecutable: (name: string) => string | undefined,
): ShellRuntime | undefined {
  if (!value) return undefined;
  const name = path.win32.basename(value).toLowerCase();
  if (name === "pwsh" || name === "pwsh.exe") {
    return powershellRuntime("pwsh", findExecutable("pwsh") ?? value);
  }
  if (name === "powershell" || name === "powershell.exe") {
    return powershellRuntime("powershell", value);
  }
  if (name === "cmd" || name === "cmd.exe") {
    return {
      executable: value || env.ComSpec || "cmd.exe",
      displayName: CMD_DISPLAY_NAME,
      kind: "cmd",
      syntax: "cmd",
    };
  }
  return undefined;
}

function powershellRuntime(kind: "pwsh" | "powershell", executable: string): ShellRuntime {
  return {
    executable,
    displayName: kind === "pwsh" ? POWERSHELL_7_DISPLAY_NAME : POWERSHELL_5_DISPLAY_NAME,
    kind,
    syntax: "powershell",
  };
}

function resolvePosixShell(
  configured: string | undefined,
  platform: NodeJS.Platform,
): ShellRuntime {
  const candidate = configured?.trim();
  if (candidate && isPosixShell(candidate)) return posixRuntime(candidate);
  return posixRuntime(platform === "darwin" ? "/bin/zsh" : "sh");
}

function isPosixShell(executable: string): boolean {
  const name = path.basename(executable).toLowerCase();
  return POSIX_SHELLS.has(name);
}

function posixRuntime(executable: string): ShellRuntime {
  const name = path.basename(executable).toLowerCase();
  const kind: ShellKind = POSIX_SHELLS.has(name) ? (name as ShellKind) : "sh";
  return { executable, displayName: executable, kind, syntax: "posix" };
}

function findWindowsExecutable(name: string, env: NodeJS.ProcessEnv): string | undefined {
  if (process.platform !== "win32") return undefined;
  const pathValue = env.PATH ?? env.Path ?? "";
  const extensions = (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .filter(Boolean)
    .map((extension) => extension.toLowerCase());
  const names = path.win32.extname(name)
    ? [name]
    : extensions.map((extension) => `${name}${extension}`);
  for (const directory of pathValue.split(";")) {
    if (!directory) continue;
    for (const candidate of names) {
      const fullPath = path.win32.join(directory, candidate);
      if (existsSync(fullPath)) return fullPath;
    }
  }
  return undefined;
}

/** 给模型提示用的 shell 语法事实；不参与 spawn。 */
export function describeShellSyntax(runtime: ShellRuntime): string {
  if (runtime.kind === "powershell") {
    return "使用 Windows PowerShell 5.1 语法；不支持 &&，顺序执行用 `cmd1; if ($?) { cmd2 }`；路径使用 Windows 分隔符。";
  }
  if (runtime.kind === "pwsh") {
    return "使用 PowerShell 7+ 语法；支持 &&，路径使用当前平台分隔符。";
  }
  if (runtime.kind === "cmd") {
    return "使用 cmd.exe 语法；环境变量用 %VAR%，顺序执行用 &&。";
  }
  return "使用 POSIX shell 语法；路径使用 /，顺序执行可用 &&。";
}

/**
 * 构造跨平台 shell 调用参数。
 *
 * PowerShell 的编码前缀、Job Object 引导和退出码收尾都放在同一条 `-Command`
 * 脚本里；POSIX 直接执行 shell -c；cmd.exe 用 /d /s /c。一次性命令与会话命令
 * 共用此入口，避免两条路径的 shell 语义再次漂移。
 */
export function buildShellInvocation(
  command: string,
  options: ShellInvocationOptions = {},
): ShellInvocation {
  const runtime = resolveShellRuntime(options);
  if (runtime.syntax === "posix") {
    return { ...runtime, args: ["-c", command] };
  }
  if (runtime.syntax === "cmd") {
    return { ...runtime, args: ["/d", "/s", "/c", command] };
  }

  const script = [
    POWERSHELL_PREFIX,
    options.windowsBootstrap,
    command,
    POWERSHELL_EXIT_CODE_TRAILER,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n");
  return {
    ...runtime,
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
  };
}
