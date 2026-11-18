#!/usr/bin/env node
/** 开发期数据库重置：只删除 sessions.sqlite 及其 WAL/SHM，不碰 legacy 归档。 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

if (!process.argv.includes("--yes")) {
  console.error("db:reset 会删除本地开发会话数据库；确认后追加 --yes。");
  process.exit(1);
}

const appData = resolveAppDataRoot();
const roots = [
  path.join(appData, "Answra", "cli", "sessions"),
  path.join(appData, "@answra", "desktop", "desktop-sessions"),
];

let removed = 0;
let failed = 0;
for (const root of roots) {
  if (!existsSync(root)) continue;
  for (const name of readdirSync(root)) {
    if (!name.startsWith("sessions.sqlite")) continue;
    const target = path.join(root, name);
    try {
      rmSync(target, { force: true });
    } catch (error) {
      if (isFileBusy(error)) {
        console.error(`无法删除 ${target}：数据库正在使用，请先退出 CLI/桌面后重试。`);
        failed += 1;
        process.exitCode = 1;
        continue;
      }
      throw error;
    }
    removed += 1;
    console.log(`removed ${target}`);
  }
}

if (failed > 0) {
  console.log(`已删除 ${removed} 个数据库文件，${failed} 个文件删除失败。`);
} else {
  console.log(removed === 0 ? "没有找到开发会话数据库。" : `已删除 ${removed} 个数据库文件。`);
}

function resolveAppDataRoot() {
  if (process.platform === "win32") {
    return process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming");
  }
  if (process.platform === "darwin") {
    return path.join(homedir(), "Library", "Application Support");
  }
  return process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config");
}

function isFileBusy(error) {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "EPERM" || error.code === "EBUSY";
}
