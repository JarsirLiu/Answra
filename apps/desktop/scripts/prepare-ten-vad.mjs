import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

/**
 * 准备 TEN VAD 预编译资源：按 native/ten-vad-resources.json 锁定 revision 与
 * SHA-256 下载 wasm/glue/许可文本，落盘到 resources/vad/（含运行时校验用的
 * manifest.json）。二进制不提交 Git；分发经 electron-builder extraResources。
 * 运行方式：`pnpm --filter @answra/desktop vad:prepare`（cwd = apps/desktop）。
 */

const execFile = promisify(execFileCallback);
const desktopRoot = process.cwd();
const manifestPath = join(desktopRoot, "native", "ten-vad-resources.json");
const resourceRoot = join(desktopRoot, "resources", "vad");
const cacheRoot = join(desktopRoot, ".cache-vad");
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const CURL_COMMAND = process.platform === "win32" ? "curl.exe" : "curl";

const source = JSON.parse(await readFile(manifestPath, "utf8")).tenVad;
await mkdir(cacheRoot, { recursive: true });
const temporaryRoot = await mkdtemp(join(cacheRoot, "prepare-"));
try {
  const stagedRoot = join(temporaryRoot, "prepared");
  for (const file of source.files) {
    const cacheFile = await acquire(file, temporaryRoot);
    const destination = join(stagedRoot, file.dir, file.name);
    await mkdir(join(stagedRoot, file.dir), { recursive: true });
    await copyFile(cacheFile, destination);
  }
  // 运行时 manifest 只保留校验所需字段；URL/路径由本脚本 Exclusive 维护在 native/ 源清单。
  const runtimeManifest = {
    tenVad: {
      repository: source.repository,
      revision: source.revision,
      version: source.version,
      license: source.license,
      files: source.files.map(({ name, sha256 }) => ({ name, sha256 })),
    },
  };
  await writeFile(
    join(stagedRoot, "manifest.json"),
    `${JSON.stringify(runtimeManifest, null, 2)}\n`,
  );
  await replaceDirectory(stagedRoot, resourceRoot);
  console.log(
    `[vad] verified and prepared TEN VAD ${source.version} (${source.revision.slice(0, 8)})`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function acquire(asset, temp) {
  const cacheFile = join(cacheRoot, asset.name);
  await mkdir(cacheRoot, { recursive: true });
  if (await hasExpectedHash(cacheFile, asset.sha256)) return cacheFile;

  const partial = join(temp, `${asset.name}.part`);
  console.log(`[vad] downloading ${asset.name}`);
  await downloadWithCurl(asset.url, partial);
  const bytes = await readFile(partial);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== asset.sha256.toLowerCase()) {
    await rm(partial, { force: true });
    throw new Error(
      `SHA-256 mismatch for ${asset.name}: expected ${asset.sha256}, received ${hash}`,
    );
  }
  await rm(cacheFile, { force: true });
  await rename(partial, cacheFile);
  return cacheFile;
}

async function hasExpectedHash(file, expected) {
  try {
    const hash = createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
    return hash === expected.toLowerCase();
  } catch {
    return false;
  }
}

async function downloadWithCurl(url, outputPath) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const args = [
      "--fail",
      "--location",
      "--silent",
      "--show-error",
      "--connect-timeout",
      "60",
      "--max-time",
      String(DOWNLOAD_TIMEOUT_MS / 1000),
    ];
    if (outputPath) args.push("--output", outputPath);
    args.push(url);
    try {
      await execFile(CURL_COMMAND, args, { maxBuffer: 1024 * 1024 });
      return;
    } catch (error) {
      const details = `${error instanceof Error ? error.message : String(error)} ${error?.stderr ?? ""}`;
      const status = Number(details.match(/returned error:\s*(\d{3})/i)?.[1]);
      const permanentHttpError = status >= 400 && status < 500 && status !== 429;
      if (permanentHttpError || attempt === 2) throw error;
      if (outputPath) await rm(outputPath, { force: true });
      await delay(500 * (attempt + 1));
    }
  }
  throw new Error(`download failed after retries: ${url}`);
}

async function replaceDirectory(sourceDir, destination) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(join(destination, ".."), { recursive: true });
  await rename(sourceDir, destination);
}
