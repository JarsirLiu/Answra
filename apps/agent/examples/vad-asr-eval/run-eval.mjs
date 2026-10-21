#!/usr/bin/env node
// 一键评测：校验资产 → 设环境变量 → 经 pnpm 拉起 vitest 跑 chain-eval.test.ts
// → 产物固定为 examples/vad-asr-eval/out/results.csv + out/summary.csv。
// 用法：
//   node run-eval.mjs                        # 默认只跑 small（单模型顺序解码，避免并发负载）
//   node run-eval.mjs --models small large  # 仍单进程顺序解码；sense 直调口径已记档、不再走 adapter 评测
// 前置：先跑 fetch-assets.mjs 下载模型与 AISHELL 对照集。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const alias = {
  small: "paraformer-zh-small-int8",
  large: "paraformer-zh-large-int8",
  sense: "sensevoice-small-int8",
};
const args = process.argv.slice(2);
// pnpm 可能吃掉逗号或 --models flag；alias 词（small/large）无论带不带 flag 都接受。
const picked = args
  .flatMap((token) => token.split(/[,\s]+/))
  .filter((k) => alias[k])
  .map((k) => alias[k]);
const models = (picked.length ? picked : ["small"]).map((k) => alias[k] ?? k).join(",");
const modelsDir = path.join(evalDir, "models");
const dataDir = path.join(evalDir, "data");

const missing = models
  .split(",")
  .filter((id) => !existsSync(path.join(modelsDir, id, "model.int8.onnx")));
for (const id of missing) {
  if (!existsSync(path.join(modelsDir, id, "model.int8.onnx"))) {
    console.error(`缺少模型 ${id}：先运行 pnpm --filter @answra/agent eval:asr:fetch`);
    process.exit(1);
  }
}
if (!existsSync(path.join(dataDir, "train", "S0002"))) {
  console.error("缺少 AISHELL-1 S0002 对照集：先运行 pnpm --filter @answra/agent eval:asr:fetch");
  process.exit(1);
}

const env = {
  ...process.env,
  ANSWRA_ASR_EVAL_RUN: "1",
  ANSWRA_ASR_EVAL_DIR: evalDir,
  ANSWRA_ASR_EVAL_MODELS: models,
};
const res = spawnSync("pnpm", ["--filter", "@answra/agent", "test", "--", "vad-asr-eval"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env,
});
if (res.status !== 0) {
  console.error("评测运行失败（见上方 vitest 输出）");
  process.exit(res.status ?? 1);
}
console.log("\n评测完成：");
console.log(`  逐段: ${path.relative(process.cwd(), path.join(evalDir, "out", "results.csv"))}`);
console.log(`  汇总: ${path.relative(process.cwd(), path.join(evalDir, "out", "summary.csv"))}`);
