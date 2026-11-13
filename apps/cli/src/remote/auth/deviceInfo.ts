/** CLI 设备描述：稳定 ID 持久化在非 secret 文件，名称与 OS 来自运行时。 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { resolveDefaultConfigDir } from "@answra/config";
import type { AuthDeviceDescriptor } from "./serviceEndpoints";

const DEVICE_FILE = "cli-device.json";

export function defaultCliDevicePath(): string {
  return path.join(resolveDefaultConfigDir(), DEVICE_FILE);
}

export async function resolveCliDeviceDescriptor(
  filePath: string = defaultCliDevicePath(),
): Promise<AuthDeviceDescriptor> {
  const id = (await readDeviceId(filePath)) ?? (await createDeviceId(filePath));
  return { id, name: hostname(), os: process.platform };
}

async function readDeviceId(filePath: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  try {
    const value = JSON.parse(raw) as unknown;
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as { id?: unknown }).id === "string" &&
      (value as { id: string }).id !== ""
    ) {
      return (value as { id: string }).id;
    }
  } catch {
    // 损坏的设备文件不影响登录，重新生成稳定 ID。
  }
  return null;
}

async function createDeviceId(filePath: string): Promise<string> {
  const id = randomUUID();
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${JSON.stringify({ version: 1, id }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return id;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
