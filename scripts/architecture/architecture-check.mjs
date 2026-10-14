#!/usr/bin/node
/**
 * 架构守护（参照 ZCode 的 architecture-check 思路）：
 *
 * 1. forbidDeepImports —— 跨包导入只能使用该包 exports 声明的入口，
 *    不允许相对路径穿透到其它包内部。
 * 2. forbidCycles —— workspace 依赖图必须无环。
 * 3. rendererIsolation —— electron / node: 模块仅允许在
 *    apps/desktop 的 src/main、src/preload 与 apps/app（独立 Node 服务）中使用；
 *    渲染层（packages/ui、desktop renderer）必须通过 DesktopBridge。
 *
 * 用法：node scripts/architecture/architecture-check.mjs check
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SKIP_DIRS = new Set(["node_modules", "dist", "out", "release"]);

const errors = [];
/** 包名 -> 该包源码里 import 的 workspace 包入口集合 */
const depGraph = new Map();

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      yield* walk(full);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      yield full;
    }
  }
}

function workspacePackages() {
  const result = [];
  for (const group of ["packages", "apps"]) {
    const groupDir = path.join(ROOT, group);
    for (const name of readdirSync(groupDir)) {
      const dir = path.join(groupDir, name);
      if (statSync(dir).isDirectory()) {
        result.push({
          dir,
          manifest: JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")),
        });
      }
    }
  }
  return result;
}

const packages = workspacePackages();
const dirByPkgName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg.dir]));

function checkImports(pkg) {
  const imports = new Set();

  for (const file of walk(pkg.dir)) {
    const rel = path.relative(ROOT, file);
    const code = readFileSync(file, "utf8");

    if (
      rel.replaceAll("\\", "/").startsWith("apps/desktop/src/main/") &&
      /new\s+BrowserWindow\s*\(/.test(code)
    ) {
      if (!code.includes("registerWindowPolicy")) {
        errors.push(`${rel}: BrowserWindow 必须登记窗口角色和共享策略`);
      }
      if (!code.includes("prepareWindowToShow")) {
        errors.push(`${rel}: BrowserWindow 显示前必须调用 prepareWindowToShow`);
      }
    }

    for (const match of code.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)) {
      const spec = match[1];

      // 1. workspace 包导入：必须是该包 exports 声明的入口
      if (spec.startsWith("@answra/")) {
        imports.add(spec);
        const targetPkgName = dirByPkgName.has(spec)
          ? spec
          : [...dirByPkgName.keys()].find((name) => spec.startsWith(`${name}/`));
        if (targetPkgName && dirByPkgName.get(targetPkgName) !== pkg.dir) {
          const targetDir = dirByPkgName.get(targetPkgName);
          const manifest = JSON.parse(readFileSync(path.join(targetDir, "package.json"), "utf8"));
          const exportKey = `.${spec.slice(targetPkgName.length)}`;
          const exported = Object.keys(manifest.exports ?? {});
          if (!exported.includes(exportKey)) {
            errors.push(
              `${rel}: 导入 "${spec}" 未出现在 ${targetPkgName} 的 exports 中（禁止深导入）`,
            );
          }
        }
        continue;
      }

      // 2. 相对导入不得逃出本包目录
      if (spec.startsWith("./") || spec.startsWith("../")) {
        const resolved = path.resolve(path.dirname(file), spec);
        for (const [name, dir] of dirByPkgName) {
          if (dir !== pkg.dir && resolved.startsWith(dir + path.sep)) {
            errors.push(`${rel}: 相对导入穿透到其它包 "${name}"，请改用包公开入口`);
          }
        }
        continue;
      }

      // 3. electron / node 内置模块仅限 desktop main / preload
      if (/^(electron|node:)/.test(spec)) {
        const normalized = rel.replaceAll("\\", "/");
        const allowed =
          normalized.startsWith("apps/desktop/src/main/") ||
          normalized.startsWith("apps/desktop/src/preload/") ||
          normalized.startsWith("apps/app/src/");
        if (!allowed) {
          errors.push(`${rel}: "${spec}" 仅允许在 apps/desktop 的 main/preload 中使用`);
        }
      }
    }

    depGraph.set(pkg.manifest.name, imports);
  }
}

for (const pkg of packages) checkImports(pkg);

// 环检测（DFS 三色标记）
const WHITE = 0;
const GRAY = 1;
const BLACK = 2;
const color = new Map(packages.map((pkg) => [pkg.manifest.name, WHITE]));

function visit(name, stack) {
  color.set(name, GRAY);
  for (const dep of depGraph.get(name) ?? []) {
    if (!depGraph.has(dep)) continue;
    if (color.get(dep) === GRAY) {
      errors.push(`workspace 依赖成环: ${[...stack, name, dep].join(" -> ")}`);
    } else if (color.get(dep) === WHITE) {
      visit(dep, [...stack, name]);
    }
  }
  color.set(name, BLACK);
}

for (const pkg of packages) {
  if (color.get(pkg.manifest.name) === WHITE) visit(pkg.manifest.name, []);
}

if (process.argv[2] === "check") {
  if (errors.length > 0) {
    for (const error of errors) console.error(`✗ ${error}`);
    process.exit(1);
  }
  console.log(
    `✓ 架构检查通过（${packages.length} 个 workspace 包：无深导入、无环、无越界平台依赖）`,
  );
}
