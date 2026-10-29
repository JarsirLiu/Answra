import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const roots = ["out", "dist"];
const forbiddenExtensions = new Set([".map", ".ts", ".tsx", ".mts", ".cts"]);
const violations = [];

async function visit(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      await visit(root, path);
      continue;
    }
    const extension = entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase();
    if (forbiddenExtensions.has(extension)) violations.push(relative(root, path));
  }
}

for (const root of roots) {
  const info = await stat(root);
  if (!info.isDirectory()) throw new Error(`打包输入目录不是目录：${root}`);
  await visit(root);
}

if (violations.length > 0) {
  throw new Error(`打包输入包含源码或 source map：\n${violations.join("\n")}`);
}

console.log(`✓ 打包输入审计通过（${roots.join("、")} 不含源码与 source map）`);
