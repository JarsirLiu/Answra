import { existsSync } from "node:fs";
import { chmod, cp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { build } from "esbuild";

const appRoot = path.resolve(import.meta.dirname, "..");
const outDir = path.join(appRoot, "dist");
const outfile = path.join(outDir, "main.mjs");
const require = createRequire(import.meta.url);

await rm(outDir, { recursive: true, force: true });
await build({
  absWorkingDir: appRoot,
  entryPoints: ["src/main.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  external: ["@napi-rs/keyring", "node-datachannel"],
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

await copyNativePackages();
if (process.platform !== "win32") await chmod(outfile, 0o755);

async function copyNativePackages() {
  await copyNativePackage("@napi-rs/keyring");
  await copyNativePackage("node-datachannel");
}

/**
 * 原生包不能被 esbuild 打进 bundle：复制包本身、当前平台可解析的可选二进制
 * 以及普通依赖，保持 pnpm 的隔离布局在发布目录仍然成立。
 */
async function copyNativePackage(name) {
  const entry = require.resolve(name);
  const packageRoot = findPackageRoot(entry);
  const manifestPath = path.join(packageRoot, "package.json");
  const packageRequire = createRequire(manifestPath);
  const manifest = packageRequire(manifestPath);
  const packageNames = [
    name,
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ];

  for (const packageName of packageNames) {
    let resolvedEntry;
    try {
      resolvedEntry = packageRequire.resolve(packageName);
    } catch {
      continue;
    }
    const sourceRoot = findPackageRoot(resolvedEntry);
    const destination = path.join(outDir, "node_modules", packageName);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(sourceRoot, destination, { recursive: true, dereference: true });
  }
}

function findPackageRoot(entry) {
  let directory = path.dirname(entry);
  while (directory !== path.dirname(directory)) {
    if (existsSync(path.join(directory, "package.json"))) return directory;
    directory = path.dirname(directory);
  }
  throw new Error(`could not find package root for ${entry}`);
}
