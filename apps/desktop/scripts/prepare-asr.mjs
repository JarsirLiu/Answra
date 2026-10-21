import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

/**
 * 准备本地 ASR 预编译模型资源：按 native/asr-resources.json 锁定 revision 与
 * SHA-256 下载 paraformer-zh-small int8（model.int8.onnx + tokens.txt）和
 * FunASR 许可原文，落盘到 resources/asr/（含运行时校验用的 manifest.json）。
 * 模型不提交 Git；分发经 electron-builder extraResources。
 * 运行方式：`pnpm --filter @answra/desktop asr:prepare`（cwd = apps/desktop）。
 */

const execFile = promisify(execFileCallback);
const desktopRoot = process.cwd();
const manifestPath = join(desktopRoot, "native", "asr-resources.json");
const resourceRoot = join(desktopRoot, "resources", "asr");
const cacheRoot = join(desktopRoot, ".cache-asr");
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const DOWNLOAD_ATTEMPTS = 30;
const DOWNLOAD_RETRY_DELAY_MS = 2_000;
const CURL_COMMAND = process.platform === "win32" ? "curl.exe" : "curl";

const source = JSON.parse(await readFile(manifestPath, "utf8")).asr;
await mkdir(cacheRoot, { recursive: true });
await removeStaleStagingDirs();
const temporaryRoot = await mkdtemp(join(cacheRoot, "prepare-"));
try {
  const stagedRoot = join(temporaryRoot, "prepared");
  for (const file of source.files) {
    const cacheFile = await acquire(file);
    const destination = join(stagedRoot, file.dir, file.name);
    await mkdir(join(stagedRoot, file.dir), { recursive: true });
    await copyFile(cacheFile, destination);
  }
  // 运行时 manifest 只保留校验所需字段；URL/路径由本脚本 Exclusive 维护在 native/ 源清单。
  const runtimeManifest = {
    asr: {
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
    `[asr] verified and prepared ${source.repository} ${source.version} (${source.revision.slice(0, 8)})`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function acquire(asset) {
  const cacheFile = join(cacheRoot, asset.name);
  await mkdir(cacheRoot, { recursive: true });
  if (await hasExpectedHash(cacheFile, asset.sha256)) return cacheFile;

  // partial 放在 cache 根目录：进程被中断后下次运行可从断点继续，不丢已下载进度。
  const partial = join(cacheRoot, `${asset.name}.part`);
  console.log(`[asr] downloading ${asset.name}`);
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

/**
 * 大文件（模型约 82MB）在长连接中易被中途重置：每次重试都从已有 partial 断点
 * 续传（curl -C -），partial 落在 cache 根目录因此跨进程保留。资源源
 * （hf-mirror/CloudFront）已确认支持字节区间；若服务端不支持续传（curl 退出码
 * 33），清掉 partial 从头下载。全部尝试失败才整体报错。
 */
async function downloadWithCurl(url, outputPath) {
  const baseArgs = [
    "--fail",
    "--location",
    "--silent",
    "--show-error",
    "--connect-timeout",
    "60",
    "--max-time",
    String(DOWNLOAD_TIMEOUT_MS / 1000),
    "--output",
    outputPath,
  ];
  let resumeFrom = await fileSize(outputPath);
  for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS; attempt += 1) {
    const args = [...baseArgs];
    if (resumeFrom > 0) {
      console.log(
        `[asr] resuming ${basename(outputPath)} from ${resumeFrom.toLocaleString()} bytes`,
      );
      args.push("--continue-at", "-");
    }
    args.push(url);
    try {
      await execFile(CURL_COMMAND, args, { maxBuffer: 1024 * 1024 });
      return;
    } catch (error) {
      const details = `${error instanceof Error ? error.message : String(error)} ${error?.stderr ?? ""}`;
      const statusMatch = details.match(/returned error:\s*(\d{3})/i);
      const status = Number(statusMatch?.[1]);
      const permanentHttpError = status >= 400 && status < 500 && status !== 429;
      if (permanentHttpError || attempt === DOWNLOAD_ATTEMPTS - 1) throw error;
      if (error.code === 33) await rm(outputPath, { force: true });
      resumeFrom = await fileSize(outputPath);
      await delay(DOWNLOAD_RETRY_DELAY_MS * (attempt + 1));
    }
  }
  throw new Error(`download failed after retries: ${url}`);
}

async function fileSize(file) {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

/** 上次运行被中断会留下 staging 目录：启动时清掉，不让缓存目录无限堆积。 */
async function removeStaleStagingDirs() {
  const entries = await readdir(cacheRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith("prepare-"))
      await rm(join(cacheRoot, entry.name), { recursive: true, force: true });
  }
}

async function replaceDirectory(sourceDir, destination) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(join(destination, ".."), { recursive: true });
  await rename(sourceDir, destination);
}
