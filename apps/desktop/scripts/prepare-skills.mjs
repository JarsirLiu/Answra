import { cp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import process from "node:process";

/**
 * 把内置 skill 内容包复制到 resources/skills/，供 electron-builder 经
 * extraResources 分发；运行时由 agentWorkerHost 解析后注入 Agent。
 * 单一事实源是 packages/skills，本目录是打包中间产物。
 * 运行方式：`pnpm --filter @answra/desktop skills:prepare`（cwd = apps/desktop）。
 */

const require = createRequire(import.meta.url);
const desktopRoot = process.cwd();
const destination = join(desktopRoot, "resources", "skills");

// 内容包没有入口文件，用包清单定位根目录。
const sourceRoot = dirname(require.resolve("@answra/skills/package.json"));

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(sourceRoot, destination, {
  recursive: true,
  dereference: true,
  // 只复制内容本身，不复制包清单。
  filter: (source) => !source.endsWith("package.json"),
});

console.log(`✓ 已准备内置 skill：${destination}`);
