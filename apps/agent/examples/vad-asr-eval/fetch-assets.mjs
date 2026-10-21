#!/usr/bin/env node
import { spawnSync } from "node:child_process";
// 评测资产一键下载：模型（sherpa-onnx 转换 channel）+ AISHELL-1 S0002 对照集。
// 来源与 SHA-256 唯一事实来源为 assets.manifest.json；SHA 不匹配必须重下。
// 用法：
//   node fetch-assets.mjs                      # 默认下载 small + sense
//   node fetch-assets.mjs --models small large
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(evalDir, "assets.manifest.json"), "utf8"));
const modelsRoot = path.join(evalDir, "models");
const dataRoot = path.join(evalDir, "data");

const alias = {
  small: "paraformer-zh-small-int8",
  large: "paraformer-zh-large-int8",
  sense: "sensevoice-small-int8",
};
const args = process.argv.slice(2);
// pnpm 可能吃掉逗号或 --models flag；alias 词（small/large）无论带不带 flag 都接受。
const requested = args.flatMap((token) => token.split(/[,\s]+/)).filter((k) => alias[k]);
const modelIds = (requested.length ? requested : ["small", "sense"]).map((k) => alias[k]);

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

async function ensureFile(entry, destDir, label) {
  const dest = path.join(destDir, label);
  if (existsSync(dest) && (await sha256(dest)) === entry.sha256) {
    console.log(`[ok] 已存在且 SHA 匹配: ${label}`);
    return { dest, existed: true };
  }
  if (existsSync(dest))
    console.warn(`[fix] ${label} SHA 不匹配（${statSync(dest).size} bytes），重新下载`);
  mkdirSync(destDir, { recursive: true });
  await downloadWithFallback(entry.url, dest, label);
  const actual = await sha256(dest);
  if (actual !== entry.sha256)
    throw new Error(`SHA-256 校验失败: ${dest}\n  期望 ${entry.sha256}\n  实际 ${actual}`);
  console.log(`[ok] 下载并校验: ${label} (${entry.bytes} bytes)`);
  return { dest, existed: false };
}

// node fetch（undici）偶发 ConnectTimeout；失败退到系统 PowerShell 下载，再统一 SHA 校验。
async function downloadWithFallback(url, dest, label) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await pipeline(res.body, createWriteStream(dest));
      return;
    } catch (error) {
      console.warn(`[retry ${attempt}] node fetch 失败（${label}）：${error?.message ?? error}`);
    }
  }
  const res = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -MaximumRedirection 5 -Uri '${url}' -OutFile '${dest}'`,
    ],
    { stdio: "inherit", timeout: 600_000, shell: false },
  );
  if (res.status !== 0 || !existsSync(dest))
    throw new Error(`PowerShell 兜底下载也失败: ${label} (${url})`);
}

function extractTarGz(archive, destDir) {
  // AISHELL speaker 包内自带 train/S0002/ 目录层，直接解到 data/ 根即可。
  mkdirSync(destDir, { recursive: true });
  const res = spawnSync("tar", ["-xzf", archive, "-C", destDir], { stdio: "inherit", shell: true });
  if (res.status !== 0) throw new Error(`tar 解包失败: ${archive}`);
  return path.join(destDir, "train", "S0002");
}

for (const id of modelIds) {
  const entry = manifest.models[id];
  if (!entry) throw new Error(`manifest 缺少模型 ${id}`);
  const destDir = path.join(modelsRoot, id);
  for (const run of entry.runs) {
    for (const file of Object.keys(run.files)) {
      await ensureFile(run.files[file], destDir, file);
    }
  }
}

for (const file of Object.keys(manifest.datasets["aishell-s0002"].files)) {
  const spec = manifest.datasets["aishell-s0002"].files[file];
  const { dest, existed } = await ensureFile(spec, dataRoot, file);
  if (spec.extract && !existed) extractTarGz(dest, dataRoot);
}
if (!existsSync(path.join(dataRoot, "train", "S0002"))) {
  extractTarGz(path.join(dataRoot, "S0002.tar.gz"), dataRoot);
}

console.log("\n资产就绪：");
console.log(`  models: ${path.relative(process.cwd(), modelsRoot)}`);
console.log(`  data:   ${path.relative(process.cwd(), dataRoot)}`);
console.log("运行评测：pnpm --filter @answra/agent eval:asr");
