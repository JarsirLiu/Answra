import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createTenVadEngine, type TenVadSource } from "@answra/agent";

/**
 * TEN VAD 预编译资源的文件源：读取 resources/vad/manifest.json（由
 * `pnpm --filter @answra/desktop vad:prepare` 生成）并逐文件 SHA-256 校验后
 * 交给 agent 组装引擎。校验失败直接抛错（fail-closed），不回落任何替代实现。
 */

interface TenVadRuntimeManifest {
  tenVad: { version?: unknown; files?: unknown };
}

interface TenVadManifestFile {
  name: string;
  sha256: string;
}

const RESOURCE_ERROR_HINT =
  "VAD 预编译资源校验失败；请运行 pnpm --filter @answra/desktop vad:prepare 后重试";

export function createTenVadFileSource(resourceRoot: string): TenVadSource {
  return {
    load: async () => {
      const files = await readVerifiedFiles(resourceRoot);
      return createTenVadEngine({ glueSource: files.glueSource, wasmBinary: files.wasmBinary });
    },
  };
}

async function readVerifiedFiles(resourceRoot: string): Promise<{
  glueSource: string;
  wasmBinary: Uint8Array;
}> {
  const manifest = await readManifest(resourceRoot);
  const glue = manifest.get("ten_vad.js");
  const wasm = manifest.get("ten_vad.wasm");
  if (!glue || !wasm) throw new Error(`${RESOURCE_ERROR_HINT}（清单缺少 glue/wasm 条目）`);
  const glueSource = (await readVerifiedResourceFile(resourceRoot, glue)).toString("utf8");
  const wasmBinary = await readVerifiedResourceFile(resourceRoot, wasm);
  return { glueSource, wasmBinary };
}

async function readManifest(resourceRoot: string): Promise<Map<string, TenVadManifestFile>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(resourceRoot, "manifest.json"), "utf8"));
  } catch (error) {
    throw new Error(`${RESOURCE_ERROR_HINT}：无法读取清单（${describe(error)}）`);
  }
  const files = (raw as TenVadRuntimeManifest)?.tenVad?.files;
  if (!Array.isArray(files)) throw new Error(`${RESOURCE_ERROR_HINT}（清单结构不合法）`);
  const entries = new Map<string, TenVadManifestFile>();
  for (const file of files) {
    if (
      typeof file === "object" &&
      file !== null &&
      "name" in file &&
      "sha256" in file &&
      typeof file.name === "string" &&
      typeof file.sha256 === "string" &&
      /^[a-f0-9]{64}$/i.test(file.sha256)
    ) {
      entries.set(file.name, { name: file.name, sha256: file.sha256 });
      continue;
    }
    throw new Error(`${RESOURCE_ERROR_HINT}（清单条目不完整）`);
  }
  return entries;
}

async function readVerifiedResourceFile(
  resourceRoot: string,
  entry: TenVadManifestFile,
): Promise<Buffer> {
  let bytes: Buffer;
  try {
    bytes = await readFile(join(resourceRoot, entry.name));
  } catch (error) {
    throw new Error(`${RESOURCE_ERROR_HINT}：缺少 ${entry.name}（${describe(error)}）`);
  }
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== entry.sha256.toLowerCase())
    throw new Error(
      `${RESOURCE_ERROR_HINT}：${entry.name} SHA-256 不匹配（期望 ${entry.sha256.slice(0, 12)}…，实际 ${hash.slice(0, 12)}…）`,
    );
  return bytes;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
