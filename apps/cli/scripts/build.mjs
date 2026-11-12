import { chmod, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { build } from "esbuild";

const appRoot = path.resolve(import.meta.dirname, "..");
const outDir = path.join(appRoot, "dist");
const outfile = path.join(outDir, "main.cjs");

await rm(outDir, { recursive: true, force: true });
await build({
  absWorkingDir: appRoot,
  entryPoints: ["src/main.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  // 运行时下限跟桌面端 Electron 35 内嵌的 Node 22.14 对齐，便于安装包复用同一 Electron。
  target: "node22.14",
  sourcemap: false,
  legalComments: "eof",
  define: {
    // ripgrep 的 ESM 入口在模块加载期用 import.meta.url 计算未使用的 rgPath；
    // 注入稳定的 file URL，避免打包后启动即 Invalid URL（与 desktop 打包同一处理）。
    "import.meta.url": JSON.stringify("file:///C:/__answra__/cli.mjs"),
  },
  logLevel: "info",
});

if (process.platform !== "win32") await chmod(outfile, 0o755);
