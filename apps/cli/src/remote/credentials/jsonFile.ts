import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export async function readProtectedJson(filePath: string): Promise<unknown | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw new Error(`无法读取远程密钥文件：${filePath}`, { cause: error });
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`远程密钥文件不是合法 JSON：${filePath}`, { cause: error });
  }
}

export async function writeProtectedJson(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: FILE_MODE,
    });
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw new Error(`无法写入远程密钥文件：${filePath}`, { cause: error });
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
