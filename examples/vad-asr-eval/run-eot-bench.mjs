#!/usr/bin/env node
// eot-bench 基线一键运行：校验资产 → 设环境变量 → 经 pnpm 拉起 vitest 跑
// eot-bench-eval.test.ts → 产物固定为 out/eot-bench-results.csv + out/eot-bench-summary.csv。
// 用法：node run-eot-bench.mjs
// 前置：先跑 fetch-eot-bench.mjs 下载真实轮次样本，并确保 paraformer 模型已就位
//       （pnpm --filter @answra/vad-asr-eval eval:asr:fetch）。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const modelId = "paraformer-zh-small-int8";

if (!existsSync(path.join(evalDir, "data", "eot-bench-zh", "turns.json"))) {
  console.error("缺少 eot-bench 样本：先运行 node fetch-eot-bench.mjs");
  process.exit(1);
}
if (!existsSync(path.join(evalDir, "models", modelId, "model.int8.onnx"))) {
  console.error(`缺少模型 ${modelId}：先运行 pnpm --filter @answra/vad-asr-eval eval:asr:fetch`);
  process.exit(1);
}

const env = {
  ...process.env,
  ANSWRA_EOT_BENCH_RUN: "1",
  ANSWRA_ASR_EVAL_DIR: evalDir,
};
const res = spawnSync(
  "pnpm",
  ["--filter", "@answra/vad-asr-eval", "exec", "vitest", "run", "eot-bench-eval.test.ts"],
  {
    stdio: "inherit",
    shell: process.platform === "win32",
    env,
  },
);
if (res.status !== 0) {
  console.error("评测运行失败（见上方 vitest 输出）");
  process.exit(res.status ?? 1);
}
console.log("\n评测完成：");
console.log(
  `  逐轮: ${path.relative(process.cwd(), path.join(evalDir, "out", "eot-bench-results.csv"))}`,
);
console.log(
  `  汇总: ${path.relative(process.cwd(), path.join(evalDir, "out", "eot-bench-summary.csv"))}`,
);
