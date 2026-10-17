import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AuthDeviceDescriptor } from "./authorizeUrl";

/**
 * 设备标识：稳定 UUID + 主机名 + 平台。
 *
 * `device` 会随授权页与 token 交换一起上报，服务端据此把 refresh token 绑定到设备
 * （同时在站点侧显示「已登录设备」）。ID 持久化在 `userData/desktop-device.json`，
 * 文件损坏或缺失时重新生成，不阻断登录。
 */

const DEVICE_FILE = "desktop-device.json";

const cache = new Map<string, Promise<AuthDeviceDescriptor>>();

/** 同一 `configDir` 只解析一次（登录/刷新/撤销共用同一设备身份）。 */
export function resolveDeviceDescriptor(configDir: string): Promise<AuthDeviceDescriptor> {
  const existing = cache.get(configDir);
  if (existing) return existing;
  const pending = loadDeviceDescriptor(configDir);
  cache.set(configDir, pending);
  return pending;
}

async function loadDeviceDescriptor(configDir: string): Promise<AuthDeviceDescriptor> {
  const file = path.join(configDir, DEVICE_FILE);
  let id: string | null = null;
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { id?: unknown };
    if (typeof parsed.id === "string" && parsed.id) id = parsed.id;
  } catch {
    // 首次运行或文件损坏：走重新生成。
  }
  if (!id) {
    id = randomUUID();
    await writeFile(file, JSON.stringify({ id })).catch(() => undefined);
  }
  return { id, name: os.hostname() || "desktop", os: process.platform };
}
