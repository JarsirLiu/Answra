import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { TEN_VAD_ONSET_THRESHOLD } from "@answra/agent";
import type { BuildOptions } from "esbuild";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

const desktopRoot = join(import.meta.dirname, "..");
const resourceRoot = join(desktopRoot, "resources", "vad");
// 资源不进 Git：本地未执行 vad:prepare 时该回归只能跳过；CI 在 Test 前固定执行准备。
const hasPreparedResources = existsSync(join(resourceRoot, "manifest.json"));

describe("TEN VAD utility process bundle regression", () => {
  it("loads prepared resources and runs one hop through a CJS bundle built like the worker entry", {
    timeout: 120_000,
    skip: !hasPreparedResources,
  }, async () => {
    const esbuild = createRequire(join(desktopRoot, "package.json"))("esbuild") as {
      build: (options: BuildOptions) => Promise<unknown>;
    };
    const outputRoot = await mkdtemp(join(tmpdir(), "answra-vad-bundle-"));
    try {
      const outfile = join(outputRoot, "vad-bundle-probe.cjs");
      // 与 build-electron.mjs 的 worker 产物同一打包形态：CJS、node 平台。
      await esbuild.build({
        entryPoints: [join(desktopRoot, "test", "vadBundleProbe.ts")],
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "node20.9",
        external: ["electron", "koffi"],
        absWorkingDir: desktopRoot,
        outfile,
      });
      const { stdout } = await run(process.execPath, [outfile, resourceRoot], {
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      });
      const verdict = JSON.parse(stdout) as SilenceVerdict;
      // 静音窗必须判为非语音；概率仍低于现役检测阈值，证明推理真实执行且静音不自触发。
      expect(verdict.voiced).toBe(false);
      expect(verdict.probability).toBeLessThan(TEN_VAD_ONSET_THRESHOLD);
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });
});

interface SilenceVerdict {
  probability: number;
  voiced: boolean;
}
