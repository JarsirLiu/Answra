import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import sevenZip from "7zip-bin";

const execFile = promisify(execFileCallback);
const desktopRoot = process.cwd();
const resourceRoot = join(desktopRoot, "resources", "rime");
const cacheRoot = join(desktopRoot, ".cache-rime");
const manifest = JSON.parse(
  await readFile(join(desktopRoot, "native", "rime-resources.json"), "utf8"),
);
const platform =
  process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : null;
if (!platform) throw new Error(`librime resources are unsupported on ${process.platform}`);

await mkdir(cacheRoot, { recursive: true });
const temporaryRoot = await mkdtemp(join(cacheRoot, "prepare-"));
try {
  await mkdir(cacheRoot, { recursive: true });
  const stagedRoot = join(temporaryRoot, "prepared");
  const platformRoot = join(stagedRoot, platform);
  const sharedRoot = join(stagedRoot, "shared");
  await mkdir(platformRoot, { recursive: true });
  await mkdir(sharedRoot, { recursive: true });

  const platformManifest = manifest.platforms[platform];
  const runtimeArchive = await acquire(platformManifest.runtime, temporaryRoot);
  const runtimeExtracted = await extract(
    runtimeArchive,
    platformManifest.runtime.format,
    temporaryRoot,
  );
  if (platform === "win32") {
    const library = await findFile(runtimeExtracted, "rime.dll");
    await copyFile(library, join(platformRoot, "librime.dll"));
  } else {
    const library = await findFile(runtimeExtracted, "librime.dylib");
    await cp(dirname(library), join(platformRoot, "lib"), { recursive: true, dereference: false });
  }

  const depsArchive = await acquire(platformManifest.deps, temporaryRoot);
  const depsExtracted = await extract(depsArchive, platformManifest.deps.format, temporaryRoot);
  const opencc = await findDirectory(depsExtracted, "opencc", "share");
  await cp(opencc, join(sharedRoot, "opencc"), { recursive: true, dereference: false });
  for (const file of ["t2s.json", "TSCharacters.ocd2", "TSPhrases.ocd2"]) {
    await copyFile(join(sharedRoot, "opencc", file), join(sharedRoot, file));
  }

  for (const source of manifest.dictionaries) {
    const archive = await acquire(source, temporaryRoot);
    const extracted = await extract(archive, source.format, temporaryRoot);
    for (const file of source.files) {
      const sourceFile = await findFile(extracted, file);
      await copyFile(sourceFile, join(sharedRoot, file));
    }
    const license = await findFile(extracted, "LICENSE");
    const authors = await findFile(extracted, "AUTHORS", false);
    const licenseDir = join(sharedRoot, "licenses", source.name);
    await mkdir(licenseDir, { recursive: true });
    await copyFile(license, join(licenseDir, "LICENSE"));
    if (authors) await copyFile(authors, join(licenseDir, "AUTHORS"));
  }

  await copyFile(
    join(desktopRoot, "native", "rime-data", "luna_pinyin_simp.custom.yaml"),
    join(sharedRoot, "luna_pinyin_simp.custom.yaml"),
  );
  await installHelper(platformRoot, platform);

  await stat(join(sharedRoot, "luna_pinyin_simp.schema.yaml"));
  await stat(join(sharedRoot, "luna_pinyin.dict.yaml"));
  await stat(join(sharedRoot, "essay.txt"));
  await stat(join(sharedRoot, "stroke.dict.yaml"));
  await stat(join(sharedRoot, "easy_en.dict.yaml"));
  await stat(join(sharedRoot, "opencc", "t2s.json"));
  await replaceDirectory(platformRoot, join(resourceRoot, platform));
  await replaceDirectory(sharedRoot, join(resourceRoot, "shared"));
  console.log(`[ime] verified and prepared ${platform} runtime, official schema data, and easy_en`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function acquire(asset, temp) {
  const cacheFile = join(cacheRoot, asset.name);
  await mkdir(cacheRoot, { recursive: true });
  if (await hasExpectedHash(cacheFile, asset.sha256)) return cacheFile;

  const partial = join(temp, `${asset.name}.part`);
  console.log(`[ime] downloading ${asset.name}`);
  const response = await fetchWithRetry(asset.url);
  const bytes = Buffer.from(await response.arrayBuffer());
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== asset.sha256.toLowerCase()) {
    throw new Error(
      `SHA-256 mismatch for ${asset.name}: expected ${asset.sha256}, received ${hash}`,
    );
  }
  await writeFile(partial, bytes);
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

async function fetchWithRetry(url) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(120_000),
      });
      if (response.ok) return response;
      if (response.status < 500 && response.status !== 429)
        throw new Error(`download failed (${response.status}): ${url}`);
      if (attempt === 2) throw new Error(`download failed (${response.status}): ${url}`);
    } catch (error) {
      if (
        attempt === 2 ||
        (error instanceof Error && error.message.startsWith("download failed (4"))
      )
        throw error;
    }
    await delay(500 * (attempt + 1));
  }
  throw new Error(`download failed after retries: ${url}`);
}

async function replaceDirectory(source, destination) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(dirname(destination), { recursive: true });
  await rename(source, destination);
}

async function extract(archive, format, temp) {
  const output = join(temp, `${basename(archive)}-extracted`);
  await mkdir(output, { recursive: true });
  if (format === "7z") {
    await execFile(sevenZip.path7za, ["x", "-y", `-o${output}`, archive]);
  } else if (format === "tar.gz") {
    await execFile("tar", ["-xzf", archive, "-C", output]);
  } else if (format === "tar.bz2") {
    await execFile("tar", ["-xjf", archive, "-C", output]);
  } else {
    throw new Error(`unsupported archive format: ${format}`);
  }
  return output;
}

async function findFile(root, name, required = true) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const match = await findFile(path, name, false);
      if (match) return match;
    } else if (entry.name === name) {
      return path;
    }
  }
  if (required) throw new Error(`resource ${name} not found in extracted upstream archive`);
  return undefined;
}

async function findDirectory(root, name, parentName) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    if (entry.name === name && basename(dirname(path)) === parentName) return path;
    const match = await findDirectory(path, name, parentName);
    if (match) return match;
  }
  throw new Error(`directory ${parentName}/${name} not found in extracted upstream archive`);
}

async function installHelper(platformRoot, targetPlatform) {
  const tag = manifest.helper.tag;
  const base = `https://github.com/${manifest.helper.repository}/releases/download/${tag}`;
  let checksumResponse;
  try {
    checksumResponse = await fetchWithRetry(`${base}/SHA256SUMS`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("(404)")) {
      throw new Error(
        `helper release ${tag} is not available; publish the tagged helper release first`,
      );
    }
    throw error;
  }
  const checksumList = await checksumResponse.text();
  const assetName = manifest.helper.assets[targetPlatform];
  const checksumLine = checksumList
    .split(/\r?\n/)
    .find((line) => line.trim().split(/\s+/).at(-1) === assetName);
  const expectedHash = checksumLine?.trim().split(/\s+/)[0];
  if (!expectedHash || !/^[a-f0-9]{64}$/i.test(expectedHash))
    throw new Error(`helper release SHA256SUMS does not contain a valid digest for ${assetName}`);
  const helperCache = await acquire(
    { name: assetName, url: `${base}/${assetName}`, sha256: expectedHash },
    temporaryRoot,
  );
  const destination = join(
    platformRoot,
    targetPlatform === "win32" ? "answra-rime-host.exe" : "answra-rime-host",
  );
  await copyFile(helperCache, destination);
  if (targetPlatform === "darwin")
    await (await import("node:fs/promises")).chmod(destination, 0o755);
}
