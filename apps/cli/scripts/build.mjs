import { chmod, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { build } from "esbuild";

const appRoot = path.resolve(import.meta.dirname, "..");
const outDir = path.join(appRoot, "dist");
const outfile = path.join(outDir, "main.mjs");

await rm(outDir, { recursive: true, force: true });
await build({
  absWorkingDir: appRoot,
  entryPoints: ["src/main.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  // 运行时下限跟桌面端 Electron 35 内嵌的 Node 22.14 对齐，便于安装包复用同一 Electron。
  target: "node22.14",
  alias: {
    "react-devtools-core": path.join(appRoot, "scripts/react-devtools-stub.mjs"),
  },
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);',
  },
  sourcemap: false,
  legalComments: "eof",
  logLevel: "info",
});

if (process.platform !== "win32") await chmod(outfile, 0o755);
