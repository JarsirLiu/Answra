import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BuildOptions } from "esbuild";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

const desktopRoot = join(import.meta.dirname, "..");
const resourceRoot = join(desktopRoot, "resources", "asr");
// 资源不进 Git（82MB 模型）：本地未执行 asr:prepare 时该回归只能跳过；CI 在 Test 前固定执行准备。
const hasPreparedResources = existsSync(join(resourceRoot, "manifest.json"));

describe("local paraformer utility process bundle regression", () => {
  it("loads prepared resources and decodes one segment through a CJS bundle built like the worker entry", {
    timeout: 180_000,
    skip: !hasPreparedResources,
  }, async () => {
    const esbuild = createRequire(join(desktopRoot, "package.json"))("esbuild") as {
      build: (options: BuildOptions) => Promise<unknown>;
    };
    const outputRoot = await mkdtemp(join(tmpdir(), "answra-asr-bundle-"));
    try {
      const outfile = join(outputRoot, "asr-bundle-probe.cjs");
      // 与 build-electron.mjs 的 worker 产物同一打包形态：CJS、node 平台、native addon 外置。
      await esbuild.build({
        entryPoints: [join(desktopRoot, "test", "asrBundleProbe.ts")],
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "node20.9",
        external: ["electron", "koffi", "sherpa-onnx-node"],
        absWorkingDir: desktopRoot,
        outfile,
      });
      const { stdout } = await run(process.execPath, [outfile, resourceRoot], {
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
      });
      const verdict = JSON.parse(stdout) as { text: string };
      expect(typeof verdict.text).toBe("string");
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });
});
