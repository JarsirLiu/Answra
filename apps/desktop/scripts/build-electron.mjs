import { build } from "esbuild";

/**
 * 打包 Electron main / preload。
 * 两端都以 CJS bundle 输出：main 可直接 require workspace 源码包，
 * preload 在 sandbox 下必须是单文件 CJS。
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
]);
