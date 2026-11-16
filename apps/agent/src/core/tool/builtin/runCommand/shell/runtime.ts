/**
 * Shell 进程的跨平台调用构造、输出解码/截断与 PowerShell 错误清理。
 * 一次性命令与会话命令共用这里，避免两条路径的编码和错误语义再次漂移。
 */

import { existsSync } from "node:fs";
import path from "node:path";

export const SHELL_OUTPUT_BUFFER_BYTES = 10 * 1024 * 1024;

const POWERSHELL_5_EXECUTABLE = "powershell.exe";
const POWERSHELL_5_DISPLAY_NAME = "Windows PowerShell 5.1 (powershell.exe)";
const POWERSHELL_7_DISPLAY_NAME = "PowerShell 7+ (pwsh)";
const CMD_DISPLAY_NAME = "cmd.exe";

const POWERSHELL_PREFIX = [
  "[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)",
  "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
  "$OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
  // Windows PowerShell 5.1 otherwise reads text files with the system code page.
  "$PSDefaultParameterValues['Get-Content:Encoding'] = 'utf8'",
].join("\n");

const POWERSHELL_EXIT_CODE_TRAILER = "if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }";
const POWERSHELL_ECHO_START =
  "[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)";

const POWERSHELL_CATEGORY_LINE = /(?:^|\r?\n)\s*\+\s+(?:CategoryInfo|FullyQualifiedErrorId)\b/u;
const POWERSHELL_LOCATION_LINE = /^\s*(?:At line:|所在位置 行:)/u;

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

export interface TruncatedShellOutput {
  readonly value: string;
  readonly truncated: boolean;
  readonly omittedChars: number;
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

export function decodeShellOutput(value: Buffer | string): string {
  if (typeof value === "string") return value;

  try {
    // A literal U+FFFD is valid UTF-8; only an invalid byte sequence may fall back to GBK.
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    // Windows 中文环境通常使用 GBK（代码页 936）输出 PowerShell 错误文本。
    return new TextDecoder("gbk").decode(value);
  }
}

export function truncateShellOutput(value: string, maxLength: number): TruncatedShellOutput {
  const characters = Array.from(value);
  if (characters.length <= maxLength) return { value, truncated: false, omittedChars: 0 };

  const marker = "\n...[output truncated]...\n";
  const contentLength = Math.max(maxLength - Array.from(marker).length, 2);
  const headLength = Math.ceil(contentLength / 2);
  const tailLength = Math.floor(contentLength / 2);
  const omittedChars = Math.max(characters.length - headLength - tailLength, 0);
  const detailMarker = `\n...[output truncated: ${omittedChars} chars omitted]...\n`;
  const finalMarker = Array.from(detailMarker).length < maxLength ? detailMarker : marker;
  const finalContentLength = maxLength - Array.from(finalMarker).length;
  if (finalContentLength < 2) {
    return { value: characters.slice(0, maxLength).join(""), truncated: true, omittedChars };
  }
  const finalHeadLength = Math.ceil(finalContentLength / 2);
  const finalTailLength = Math.floor(finalContentLength / 2);
  return {
    value: `${characters.slice(0, finalHeadLength).join("")}${finalMarker}${characters.slice(-finalTailLength).join("")}`,
    truncated: true,
    omittedChars,
  };
}

/**
 * 去掉 PowerShell 非交互错误流的定位块和脚本回显。
 *
 * `powershell.exe -Command` 会把整段脚本作为 `Write-Error` 的错误上下文回显，
 * 并附带 `At line`、`CategoryInfo` 等格式行。模型需要的是错误消息本身；
 * 只在检测到 PowerShell 错误包装时清理，普通原生命令 stderr 保持原样。
 */
export function stripPowerShellErrorWrapper(value: string): string {
  if (!hasPowerShellErrorWrapper(value)) return value;

  const output: string[] = [];
  let pending: string[] = [];
  let inErrorDetails = false;
  const flush = (): void => {
    output.push(...pending);
    pending = [];
  };

  for (const line of value.split(/\r?\n/u)) {
    if (inErrorDetails) {
      if (line.trim() === "") inErrorDetails = false;
      continue;
    }
    const echoMessage = readPowerShellEchoMessage(line);
    if (echoMessage !== undefined) {
      const echoStart = pending.findIndex((entry) => entry.includes(POWERSHELL_ECHO_START));
      if (echoStart >= 0) pending = pending.slice(0, echoStart);
      pending.push(echoMessage);
      continue;
    }
    if (POWERSHELL_LOCATION_LINE.test(line)) {
      flush();
      inErrorDetails = true;
      continue;
    }
    if (POWERSHELL_CATEGORY_LINE.test(line)) {
      flush();
      inErrorDetails = true;
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    pending.push(line);
  }
  flush();
  return trimBlankLines(output).join("\n");
}

function hasPowerShellErrorWrapper(value: string): boolean {
  return (
    value.includes(`${POWERSHELL_EXIT_CODE_TRAILER} :`) || POWERSHELL_CATEGORY_LINE.test(value)
  );
}

function readPowerShellEchoMessage(line: string): string | undefined {
  const marker = `${POWERSHELL_EXIT_CODE_TRAILER} : `;
  const index = line.indexOf(marker);
  return index < 0 ? undefined : line.slice(index + marker.length);
}

function trimBlankLines(lines: readonly string[]): readonly string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim() === "") start += 1;
  while (end > start && lines[end - 1]?.trim() === "") end -= 1;
  return lines.slice(start, end);
}
