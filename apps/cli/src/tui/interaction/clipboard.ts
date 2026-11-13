/** 终端复制：主路径 OSC 52，本地非 SSH 环境再异步调用系统剪贴板命令兜底。 */
import { spawn } from "node:child_process";

const OSC_52_TERMINATOR = "\x07";
const NATIVE_COPY_TIMEOUT_MS = 2_000;

export interface ClipboardWriter {
  write(text: string): void;
}

export interface NativeClipboardCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export interface ClipboardEnvironment {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  /** 执行失败时调用 onError，交给调用方尝试下一个候选命令。 */
  readonly run: (command: NativeClipboardCommand, text: string, onError: () => void) => void;
}

const defaultEnvironment: ClipboardEnvironment = {
  platform: process.platform,
  env: process.env,
  run: runNativeCommand,
};

export function createClipboardWriter(
  stdout: NodeJS.WritableStream,
  environment: ClipboardEnvironment = defaultEnvironment,
): ClipboardWriter {
  return {
    write(text: string) {
      if (text.length === 0) return;
      stdout.write(`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}${OSC_52_TERMINATOR}`);
      if (environment.env.SSH_CONNECTION !== undefined) return;
      runFirst(nativeClipboardCommands(environment.platform), text, environment.run);
    },
  };
}

/** 按平台返回本地剪贴板候选命令；Linux 按 Wayland/X11 常见工具顺序回退。 */
export function nativeClipboardCommands(
  platform: NodeJS.Platform,
): readonly NativeClipboardCommand[] {
  switch (platform) {
    case "darwin":
      return [{ command: "pbcopy", args: [] }];
    case "win32":
      return [
        {
          command: "powershell.exe",
          args: [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Console]::InputEncoding=[Text.Encoding]::UTF8; $v=[Console]::In.ReadToEnd(); Set-Clipboard -Value $v",
          ],
        },
      ];
    case "linux":
      return [
        { command: "wl-copy", args: [] },
        { command: "xclip", args: ["-selection", "clipboard"] },
        { command: "xsel", args: ["--clipboard", "--input"] },
      ];
    default:
      return [];
  }
}

function runFirst(
  commands: readonly NativeClipboardCommand[],
  text: string,
  run: ClipboardEnvironment["run"],
): void {
  const [command, ...rest] = commands;
  if (command === undefined) return;
  run(command, text, () => runFirst(rest, text, run));
}

function runNativeCommand(
  command: NativeClipboardCommand,
  text: string,
  onError: () => void,
): void {
  const child = spawn(command.command, [...command.args], {
    stdio: ["pipe", "ignore", "ignore"],
    timeout: NATIVE_COPY_TIMEOUT_MS,
  });
  let failed = false;
  const fail = (): void => {
    if (failed) return;
    failed = true;
    // OSC 52 已尝试；本地命令只是非 SSH 环境的兜底，失败不覆盖主路径结果。
    onError();
  };
  child.on("error", fail);
  child.on("close", (code) => {
    if (code !== 0) fail();
  });
  child.stdin.on("error", fail);
  child.stdin.end(text);
}
