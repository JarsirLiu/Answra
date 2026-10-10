import { copyFile, mkdir } from "node:fs/promises";
import { build } from "esbuild";

/**
 * 打包 Electron main / preload。
 * 两端都以 CJS bundle 输出：main 可直接 require workspace 源码包，
 * preload 在 sandbox 下必须是单文件 CJS。
 * 区域框选 overlay 是静态页（selection.html），复制到 out/capture 供主进程 loadFile。
 */
await Promise.all([
  build({
    entryPoints: ["src/main/index.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    outfile: "out/main/index.cjs",
  }),
  build({
    entryPoints: ["src/preload/index.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    outfile: "out/preload/index.cjs",
  }),
  build({
    entryPoints: ["src/preload/selection.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    outfile: "out/preload/selection.cjs",
  }),
  mkdir("out/capture", { recursive: true }).then(() =>
    copyFile("src/main/capture/selection.html", "out/capture/selection.html"),
  ),
]);
