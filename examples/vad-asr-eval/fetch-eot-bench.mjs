#!/usr/bin/env node
// eot-bench 真实对话样本一键下载：livekit/eot-bench-data（Apache-2.0）中文子集。
// 每条样本是一段完整用户轮次：audio（16kHz WAV）+ silence_spans（最后一段=轮次结束
// eot，之前=句中停顿 hold）+ words（词级时间戳）+ messages（对话上下文）。
// 来源、数据集 revision、逐文件 SHA-256 以 eot-bench.manifest.json 为唯一事实来源。
// 用法：
//   node fetch-eot-bench.mjs                # 默认 30 条
//   node fetch-eot-bench.mjs --count 40
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(evalDir, "data", "eot-bench-zh");
const audioDir = path.join(dataDir, "audio");
const manifestPath = path.join(dataDir, "eot-bench.manifest.json");

const DATASET = "livekit/eot-bench-data";
const CONFIG = "zh";
const SPLIT = "validation";
// 固定数据集 revision：行内容与音频字节在该 revision 下稳定，SHA 才有意义。
const REVISION = "ca9d98a9686b920a2d8c9eb984224ba9be74e4dd";

const args = process.argv.slice(2);
const countArg = args.flatMap((t) => t.split(/[,\s]+/)).find((t) => /^\d+$/.test(t));
const count = countArg ? Number(countArg) : 30;

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

async function download(url, dest, label) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await pipeline(res.body, createWriteStream(dest));
      return;
    } catch (error) {
      console.warn(`[retry ${attempt}] 下载失败（${label}）：${error?.message ?? error}`);
    }
  }
  throw new Error(`下载失败: ${label} (${url})`);
}

async function fetchRows() {
  const url =
    `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(DATASET)}` +
    `&config=${CONFIG}&split=${SPLIT}&offset=0&length=${count}`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`rows API HTTP ${res.status}`);
  const payload = await res.json();
  return payload.rows.map((r) => r.row);
}

mkdirSync(audioDir, { recursive: true });

const prior = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf8"))
  : { dataset: DATASET, config: CONFIG, split: SPLIT, revision: REVISION, turns: {} };

const rows = await fetchRows();
if (rows.length === 0) throw new Error("rows API 返回空");

const turns = [];
for (const row of rows) {
  const audioUrl = row.audio?.[0]?.src;
  if (!audioUrl) throw new Error(`样本 ${row.id} 缺 audio`);
  const dest = path.join(audioDir, `${row.id}.wav`);
  const entry = prior.turns[row.id];
  if (entry && existsSync(dest) && (await sha256(dest)) === entry.sha256) {
    console.log(`[ok] 已存在且 SHA 匹配: ${row.id}`);
  } else {
    await download(audioUrl, dest, row.id);
    const actual = await sha256(dest);
    if (entry && actual !== entry.sha256) console.warn(`[fix] ${row.id} SHA 变化，更新 manifest`);
    console.log(`[ok] 下载: ${row.id} (${(row.duration ?? 0).toFixed(2)}s)`);
  }
  const sha256Value = entry?.sha256 ?? (await sha256(dest));
  turns.push({
    id: row.id,
    duration: row.duration,
    silenceSpans: (row.silence_spans ?? []).map((s) => ({ start: s.start, end: s.end })),
    words: (row.words ?? []).map((w) => ({ start: w.start, end: w.end, word: w.word })),
    messages: (row.messages ?? []).map((m) => ({ role: m.role, content: m.content })),
  });
  prior.turns[row.id] = { sha256: sha256Value, bytes: statSync(dest).size };
}

writeFileSync(path.join(dataDir, "turns.json"), `${JSON.stringify(turns, null, 2)}\n`, "utf8");
writeFileSync(manifestPath, `${JSON.stringify(prior, null, 2)}\n`, "utf8");

const totalSec = turns.reduce((sum, t) => sum + (t.duration ?? 0), 0);
console.log(
  `\n样本就绪：${turns.length} 条，合计 ${totalSec.toFixed(1)}s（${(totalSec / 60).toFixed(2)} 分钟）`,
);
console.log(`  音频: ${path.relative(process.cwd(), audioDir)}`);
console.log(`  元数据: ${path.relative(process.cwd(), path.join(dataDir, "turns.json"))}`);
console.log(`  manifest: ${path.relative(process.cwd(), manifestPath)}`);
