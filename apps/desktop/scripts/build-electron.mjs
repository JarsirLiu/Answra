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
 * ripgrep 的 ESM 入口在模块加载时用 import.meta.url 计算未使用的 rgPath。
 * 所有包含 ripgrep 的 CJS worker 都必须注入一个合法 URL，否则启动即抛 Invalid URL。
 */
const ripgrepDefine = {
  "import.meta.url": JSON.stringify("file:///C:/__answra__/rg.mjs"),
};

/**
 * 打包 Electron main / preload。
 * 两端都以 CJS bundle 输出：main 可直接 require workspace 源码包，
 * preload 在 sandbox 下必须是单文件 CJS。
 * 区域框选 overlay 是静态页（selection.html），复制到 out/capture 供主进程 loadFile。
 */
const buildTargets = [
  {
    name: "main",
    options: {
      ...bundleOptions,
      entryPoints: ["src/main/index.ts"],
      platform: "node",
      format: "cjs",
      metafile: true,
      // electron-updater 保持外部依赖：它内部按 Electron 运行时解析路径，不可打包。
      external: ["electron", "koffi", "electron-updater"],
      outfile: "out/main/index.cjs",
    },
  },
  {
    name: "preload",
    options: {
      ...bundleOptions,
      entryPoints: [preloadEntry],
      platform: "node",
      format: "cjs",
      metafile: true,
      external: ["electron", "koffi"],
      outfile: "out/preload/index.cjs",
    },
  },
  {
    name: "selection-preload",
    options: {
      ...bundleOptions,
      entryPoints: ["src/preload/selection.ts"],
      platform: "node",
      format: "cjs",
      metafile: true,
      external: ["electron", "koffi"],
      outfile: "out/preload/selection.cjs",
    },
  },
  {
    name: "agent-worker",
    options: {
      ...bundleOptions,
      entryPoints: [agentWorkerEntry],
      platform: "node",
      format: "cjs",
      target: "node22.14",
      metafile: true,
      define: {
        ...bundleOptions.define,
        ...ripgrepDefine,
      },
      // sherpa-onnx-node 留给 utility process 运行时 require：native addon 不可打包。
      external: ["electron", "koffi", "sherpa-onnx-node"],
      outfile: "out/main/conversation/worker.cjs",
    },
  },
  ...(manifest.features.includes("chat")
    ? [
        {
          name: "grep-worker",
          options: {
            ...bundleOptions,
            define: {
              ...bundleOptions.define,
              ...ripgrepDefine,
            },
            entryPoints: ["src/main/conversation/grepWorker.ts"],
            platform: "node",
            format: "cjs",
            target: "node22.14",
            metafile: true,
            external: ["electron", "koffi"],
            outfile: "out/main/conversation/grepWorker.cjs",
          },
        },
      ]
    : []),
];

const results = await Promise.all(buildTargets.map(({ options }) => build(options)));

for (const [index, target] of buildTargets.entries()) {
  const result = results[index];
  if (result && "metafile" in result) {
    await writeFile(
      `${auditDirectory}/${target.name}.meta.json`,
      `${JSON.stringify(result.metafile, null, 2)}\n`,
    );
  }
}

await mkdir("out/capture", { recursive: true });
await copyFile("src/main/capture/selection.html", "out/capture/selection.html");
