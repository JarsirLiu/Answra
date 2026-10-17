import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { safeStorage } from "electron";

/**
 * `userData` 下的加密 JSON 小文件（AES 由 OS 密钥环提供）。
 *
 * 约定：只在 `safeStorage` 可用时落盘，不可用时**拒绝写入**，绝不明文保存凭据类数据。
 * `safeStorage` 必须在 app ready 之后调用。
 */

export async function readEncryptedJson<T>(
  configDir: string,
  file: string,
  parse: (value: unknown) => T | null,
): Promise<T | null> {
  if (!safeStorage.isEncryptionAvailable()) return null;
  let encrypted: Buffer;
  try {
    encrypted = await readFile(path.join(configDir, file));
  } catch {
    return null;
  }
  try {
    return parse(JSON.parse(safeStorage.decryptString(encrypted)));
  } catch (error) {
    // 解密/解析失败（换了机器、密钥环变化、文件损坏）等同于无此记录，并清掉不可用的密文。
    console.warn(`[auth] ${file} 无法读取，已清除`, error);
    await removeEncryptedFile(configDir, file);
    return null;
  }
}

export async function writeEncryptedJson(
  configDir: string,
  file: string,
  value: unknown,
): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("系统未提供安全存储，拒绝以明文保存登录数据");
  }
  await writeFile(path.join(configDir, file), safeStorage.encryptString(JSON.stringify(value)));
}

export async function removeEncryptedFile(configDir: string, file: string): Promise<void> {
  await rm(path.join(configDir, file), { force: true });
}
