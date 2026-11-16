/** CLI 图片附件读取的 Node 适配器：封装剪贴板命令、临时文件和文件读取。 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  type ImageAttachment,
  type ImageMediaType,
  isSupportedImageMediaType,
  MAX_IMAGE_BYTES,
} from "../image/attachment";
import type { ImageAttachmentReader } from "../image/ports";

export interface ImageCommandResult {
  readonly code: number;
  readonly stdout: Buffer;
}

export interface ImageAttachmentEnvironment {
  readonly platform: NodeJS.Platform;
  readonly run: (command: string, args: readonly string[]) => Promise<ImageCommandResult>;
  readonly readFile: (path: string) => Promise<Buffer>;
  readonly removeFile: (path: string) => Promise<void>;
  readonly tempPath: (name: string) => string;
}

const IMAGE_COMMAND_TIMEOUT_MS = 3_000;

const defaultEnvironment: ImageAttachmentEnvironment = {
  platform: process.platform,
  run: runImageCommand,
  readFile,
  removeFile: (path) => rm(path, { force: true }),
  tempPath: (name) => join(tmpdir(), `answra-${randomUUID()}-${name}`),
};

export function createImageAttachmentReader(
  environment: ImageAttachmentEnvironment = defaultEnvironment,
): ImageAttachmentReader {
  return {
    async readClipboard() {
      switch (environment.platform) {
        case "win32":
          return readClipboardFile(environment, "clipboard.png", windowsClipboardCommand);
        case "darwin":
          return readClipboardFile(environment, "clipboard.png", macClipboardCommand);
        case "linux":
          return readLinuxClipboard(environment);
        default:
          return [];
      }
    },
    async readPath(path) {
      const buffer = await environment.readFile(path);
      return toAttachment(buffer, basename(path));
    },
  };
}

class ImageAttachmentError extends Error {
  constructor(
    readonly kind: "empty" | "too-large" | "unsupported",
    message: string,
  ) {
    super(message);
    this.name = "ImageAttachmentError";
  }
}

interface ImageCommand {
  readonly command: string;
  readonly args: readonly string[];
}

async function readClipboardFile(
  environment: ImageAttachmentEnvironment,
  name: string,
  commandFor: (path: string) => ImageCommand,
): Promise<readonly ImageAttachment[]> {
  const path = environment.tempPath(name);
  try {
    const command = commandFor(path);
    const result = await environment.run(command.command, command.args);
    if (result.code !== 0) return [];
    const buffer = await environment.readFile(path);
    return [toAttachment(buffer, name)];
  } catch (error) {
    if (error instanceof ImageAttachmentError && error.kind === "too-large") throw error;
    return [];
  } finally {
    await environment.removeFile(path).catch(() => {});
  }
}

async function readLinuxClipboard(
  environment: ImageAttachmentEnvironment,
): Promise<readonly ImageAttachment[]> {
  for (const command of linuxClipboardCommands()) {
    const result = await environment.run(command.command, command.args);
    if (result.code !== 0 || result.stdout.length === 0) continue;
    try {
      return [toAttachment(result.stdout, "clipboard.png")];
    } catch (error) {
      if (error instanceof ImageAttachmentError && error.kind === "too-large") throw error;
    }
  }
  return [];
}

function toAttachment(buffer: Buffer, name: string): ImageAttachment {
  if (buffer.length === 0) throw new ImageAttachmentError("empty", "图片为空");
  if (buffer.length > MAX_IMAGE_BYTES)
    throw new ImageAttachmentError("too-large", "单张图片不能超过 8 MB");
  const mediaType = mediaTypeFromBuffer(buffer);
  if (mediaType === undefined || !isSupportedImageMediaType(mediaType)) {
    throw new ImageAttachmentError("unsupported", "图片格式仅支持 PNG、JPEG、WebP 或 GIF");
  }
  return { name, dataUrl: `data:${mediaType};base64,${buffer.toString("base64")}` };
}

function mediaTypeFromBuffer(buffer: Buffer): ImageMediaType | undefined {
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "image/png";
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return "image/gif";
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
}

function windowsClipboardCommand(path: string): ImageCommand {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms;",
    "Add-Type -AssemblyName System.Drawing;",
    "$img = [System.Windows.Forms.Clipboard]::GetImage();",
    "if ($img -eq $null) { exit 1 };",
    `$img.Save(${powershellString(path)}, [System.Drawing.Imaging.ImageFormat]::Png);`,
  ].join(" ");
  return {
    command: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-STA", "-Command", script],
  };
}

function macClipboardCommand(path: string): ImageCommand {
  const script = [
    "set png_data to (the clipboard as «class PNGf»)",
    `set fp to open for access POSIX file ${JSON.stringify(path)} with write permission`,
    "write png_data to fp",
    "close access fp",
  ].join("\n");
  return { command: "osascript", args: ["-e", script] };
}

function linuxClipboardCommands(): readonly ImageCommand[] {
  return [
    { command: "wl-paste", args: ["--type", "image/png"] },
    { command: "xclip", args: ["-selection", "clipboard", "-t", "image/png", "-o"] },
  ];
}

function powershellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function runImageCommand(command: string, args: readonly string[]): Promise<ImageCommandResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        timeout: IMAGE_COMMAND_TIMEOUT_MS,
        windowsHide: true,
        encoding: "buffer",
        maxBuffer: MAX_IMAGE_BYTES,
      },
      (error, stdout) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({
          code,
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ""),
        });
      },
    );
  });
}
