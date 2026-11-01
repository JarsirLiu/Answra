import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { resolveReleaseProfile } from "./release-profile.mjs";

const manifest = await resolveReleaseProfile();
await rm("out", { recursive: true, force: true });
await mkdir("out", { recursive: true });
await writeFile("out/release-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
const auditDirectory = `.release-audit/${manifest.profile}`;
await rm(auditDirectory, { recursive: true, force: true });
await mkdir(auditDirectory, { recursive: true });

const featureDefines = Object.fromEntries(
  [
    "answer",
    "chat",
    "workspace",
    "interview",
    "settings",
    "account",
    "announcements",
    "updates",
    "stealth",
  ].map((feature) => [
    `__ANSWRA_FEATURE_${feature.toUpperCase()}__`,
    String(manifest.features.includes(feature)),
  ]),
);
const agentWorkerEntry = manifest.features.includes("interview")
  ? "src/main/conversation/worker.ts"
  : "src/main/conversation/workerAnswer.ts";
const preloadEntry = manifest.features.includes("interview")
  ? "src/preload/index.ts"
  : "src/preload/answer.ts";

const bundleOptions = {
  bundle: true,
  minify: true,
  sourcemap: false,
  legalComments: "none",
  define: {
    ...featureDefines,
    __ANSWRA_RELEASE_MANIFEST__: JSON.stringify(JSON.stringify(manifest)),
  },
};

/**
 * 打包 Electron main / preload。
 * 两端都以 CJS bundle 输出：main 可直接 require workspace 源码包，
 * preload 在 sandbox 下必须是单文件 CJS。
 * 区域框选 overlay 是静态页（selection.html），复制到 out/capture 供主进程 loadFile。
 */
const results = await Promise.all([
  build({
    ...bundleOptions,
    entryPoints: ["src/main/index.ts"],
    platform: "node",
    format: "cjs",
    metafile: true,
    // electron-updater 保持外部依赖：它内部按 Electron 运行时解析路径，不可打包。
    external: ["electron", "koffi", "electron-updater"],
    outfile: "out/main/index.cjs",
  }),
  build({
    ...bundleOptions,
    entryPoints: [preloadEntry],
    platform: "node",
    format: "cjs",
    metafile: true,
    external: ["electron", "koffi"],
    outfile: "out/preload/index.cjs",
  }),
  build({
    ...bundleOptions,
    entryPoints: ["src/preload/selection.ts"],
    platform: "node",
    format: "cjs",
    metafile: true,
    external: ["electron", "koffi"],
    outfile: "out/preload/selection.cjs",
  }),
  build({
    ...bundleOptions,
    entryPoints: [agentWorkerEntry],
    platform: "node",
    format: "cjs",
    target: "node20.9",
    metafile: true,
    // sherpa-onnx-node 留给 utility process 运行时 require：native addon 不可打包。
    external: ["electron", "koffi", "sherpa-onnx-node"],
    outfile: "out/main/conversation/worker.cjs",
  }),
  mkdir("out/capture", { recursive: true }).then(() =>
    copyFile("src/main/capture/selection.html", "out/capture/selection.html"),
  ),
]);

for (const [index, name] of ["main", "preload", "selection-preload", "agent-worker"].entries()) {
  const result = results[index];
  if (result && "metafile" in result) {
    await writeFile(
      `${auditDirectory}/${name}.meta.json`,
      `${JSON.stringify(result.metafile, null, 2)}\n`,
    );
  }
}
