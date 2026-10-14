#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
// 环境初始化流程（对齐 WeCode 的 `pnpm bootstrap`）：
// 1. pnpm install 安装 workspace 依赖
// 2. 校验 Electron 桌面二进制是否已落盘；缺失时通过 npmmirror 镜像补下载，
//    避免 `pnpm dev` 启动时才临时下载导致卡住。
import process from "node:process";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = resolve(rootDir, "apps/desktop");
const isWin = process.platform === "win32";
const pnpmCommand = isWin ? "pnpm.cmd" : "pnpm";
const DEFAULT_ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    shell: isWin,
    ...options,
  });
  if (result.status !== 0) {
    console.error(`[bootstrap] 命令失败：${command} ${args.join(" ")}`);
    process.exit(result.status ?? 1);
  }
}

function resolveElectronDir() {
  const candidates = [
    join(desktopDir, "node_modules", "electron"),
    join(rootDir, "node_modules", "electron"),
  ];
  return candidates.find((dir) => existsSync(join(dir, "install.js")));
}

function isElectronBinaryReady(electronDir) {
  const pathTxt = join(electronDir, "path.txt");
  if (!existsSync(pathTxt)) {
    return false;
  }
  const binaryName = readFileSync(pathTxt, "utf8").trim();
  return binaryName.length > 0 && existsSync(join(electronDir, "dist", binaryName));
}

console.log("[bootstrap] 1/2 安装 workspace 依赖...");
run(pnpmCommand, ["install"]);

const electronDir = resolveElectronDir();
if (!electronDir) {
  console.error("[bootstrap] 未找到 electron 包，请确认 pnpm install 已完成。");
  process.exit(1);
}

console.log("[bootstrap] 2/2 校验 Electron 二进制...");
if (isElectronBinaryReady(electronDir)) {
  console.log("[bootstrap] Electron 二进制已就绪。");
} else {
  const mirror =
    process.env.ELECTRON_MIRROR?.trim() ||
    process.env.npm_config_electron_mirror?.trim() ||
    DEFAULT_ELECTRON_MIRROR;
  console.log(`[bootstrap] 缺失，使用镜像 ${mirror} 下载...`);
  run(process.execPath, [join(electronDir, "install.js")], {
    cwd: electronDir,
    env: { ...process.env, ELECTRON_MIRROR: mirror },
  });
  if (!isElectronBinaryReady(electronDir)) {
    console.error("[bootstrap] Electron 二进制下载后仍未就绪，请检查网络后重试 pnpm bootstrap。");
    process.exit(1);
  }
  console.log("[bootstrap] Electron 二进制下载完成。");
}

console.log("[bootstrap] 3/3 校验内置输入法资源...");
run(pnpmCommand, ["--filter", "@answra/desktop", "ime:prepare"]);
console.log("[bootstrap] 完成，可以运行 pnpm dev。");
