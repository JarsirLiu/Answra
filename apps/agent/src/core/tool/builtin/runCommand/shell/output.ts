/**
 * Shell 输出解码、截断与 PowerShell 错误清理；不持有进程、会话或 shell 选择状态。
 */

export const SHELL_OUTPUT_BUFFER_BYTES = 10 * 1024 * 1024;

export const POWERSHELL_ECHO_START =
  "[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)";
export const POWERSHELL_EXIT_CODE_TRAILER = "if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }";

const POWERSHELL_CATEGORY_LINE = /(?:^|\r?\n)\s*\+\s+(?:CategoryInfo|FullyQualifiedErrorId)\b/u;
const POWERSHELL_LOCATION_LINE = /^\s*(?:At line:|所在位置 行:)/u;

export function hasPowerShellScriptEchoPrefix(value: string): boolean {
  return value.startsWith(POWERSHELL_ECHO_START);
}

export interface TruncatedShellOutput {
  readonly value: string;
  readonly truncated: boolean;
  readonly omittedChars: number;
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
