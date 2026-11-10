/**
 * Shell 进程的跨平台调用构造、输出解码/截断与 PowerShell 错误清理。
 * 一次性命令与会话命令共用这里，避免两条路径的编码和错误语义再次漂移。
 */

export const SHELL_OUTPUT_BUFFER_BYTES = 10 * 1024 * 1024;

const POWERSHELL_EXECUTABLE = "powershell.exe";
const POWERSHELL_DISPLAY_NAME = "Windows PowerShell 5.1 (powershell.exe)";

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

export interface ShellInvocation {
  readonly executable: string;
  readonly args: readonly string[];
}

export interface ShellRuntimeOptions {
  readonly platform?: NodeJS.Platform;
  readonly shell?: string;
}

/** 当前平台上真正会被执行的 shell；提示词与 spawn 共用这一份事实。 */
export interface ShellRuntime {
  readonly executable: string;
  readonly displayName: string;
  readonly syntax: "powershell" | "posix";
}

export interface ShellInvocationOptions extends ShellRuntimeOptions {
  readonly windowsBootstrap?: string;
}

export function resolveShellRuntime(options: ShellRuntimeOptions = {}): ShellRuntime {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return {
      executable: POWERSHELL_EXECUTABLE,
      displayName: POWERSHELL_DISPLAY_NAME,
      syntax: "powershell",
    };
  }

  const configuredShell = options.shell ?? process.env.SHELL;
  const executable =
    configuredShell === undefined || configuredShell === "" ? "sh" : configuredShell;
  return { executable, displayName: executable, syntax: "posix" };
}

export interface TruncatedShellOutput {
  readonly value: string;
  readonly truncated: boolean;
  readonly omittedChars: number;
}

/**
 * 构造跨平台 shell 调用参数。
 *
 * Windows 的编码前缀、Job Object 引导和退出码收尾都放在同一条 `-Command`
 * 脚本里；POSIX 直接执行 `$SHELL -c`。一次性命令与会话命令共用此入口，
 * 避免两条路径的 PowerShell 语义再次漂移。
 */
export function buildShellInvocation(
  command: string,
  options: ShellInvocationOptions = {},
): ShellInvocation {
  const runtime = resolveShellRuntime(options);
  if (runtime.syntax === "posix") {
    return { executable: runtime.executable, args: ["-c", command] };
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
    executable: runtime.executable,
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
  };
}

export function decodeShellOutput(value: Buffer | string): string {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const utf8 = new TextDecoder("utf-8").decode(bytes);
  if (!utf8.includes("\uFFFD")) return utf8;

  // Windows 中文环境通常使用 GBK（代码页 936）输出 PowerShell 错误文本。
  return new TextDecoder("gbk").decode(bytes);
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
