#!/usr/bin/node
/**
 * 架构守护：
 *
 * 1. forbidDeepImports —— 跨包导入只能使用该包 exports 声明的入口，
 *    不允许相对路径穿透到其它包内部。
 * 2. forbidCycles —— workspace 依赖图必须无环。
 * 3. rendererIsolation —— electron / node: 模块仅允许在
 *    apps/desktop 的 src/main、src/preload、构建脚本 scripts、
 *    apps/agent（平台无关的 Agent 运行时，在 utility process 里跑）
 *    与 Node-only 的 packages/config、packages/credentials 中使用；
 *    渲染层（packages/ui、desktop renderer）必须通过 DesktopBridge。
 * 4. forbidLocalListeners —— src 里不得 createServer/listen（测试除外）：
 *    进程间通信只用 IPC / 管道 / utilityProcess。
 *
 * 用法：node scripts/architecture/architecture-check.mjs check
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SKIP_DIRS = new Set(["node_modules", "dist", "out", "release"]);

const MOBILE_ALLOWED_WORKSPACE_PACKAGES = new Set(["@answra/remote", "@answra/shared"]);
const MOBILE_CORE_FORBIDDEN_SPECS = new Set([
  "react",
  "react-dom",
  "react-native",
  "react-native-webrtc",
  "@react-native-community/netinfo",
]);

function workspacePackageName(spec) {
  if (!spec.startsWith("@")) return spec.split("/")[0];
  return spec.split("/").slice(0, 2).join("/");
}

const errors = [];
/** 包名 -> 该包源码里 import 的 workspace 包入口集合 */
const depGraph = new Map();

/**
 * 本地监听白名单仅用于一次性 OAuth 环回回调；新增场景需单独 Note。
 */
const LOCAL_LISTENER_EXCEPTIONS = new Map([
  [
    "apps/desktop/src/main/auth/loopbackCallback.ts",
    {
      "只绑定 127.0.0.1": /LOOPBACK_HOST\s*=\s*"127\.0\.0\.1"/,
      打包版禁用: /app\.isPackaged/,
    },
  ],
  [
    "apps/cli/src/remote/auth/localAuthCallback.ts",
    {
      "只绑定 127.0.0.1": /server\.listen\(0,\s*["']127\.0\.0\.1["']/,
      动态分配端口: /server\.listen\(0,/,
      "固定 OAuth 回调路径": /const CALLBACK_PATH = ["']\/auth\/callback["']/,
      登录结束关闭监听: /close:\s*async\s*\(\)\s*=>/,
    },
  ],
]);

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
    const normalizedRel = rel.replaceAll("\\", "/");
    const code = readFileSync(file, "utf8");

    // 5. 事件 schema 单一来源：shared 不得绑定 AI SDK，AI SDK 消息类型只在 core 归一化层出现。
    if (normalizedRel.startsWith("packages/shared/") && /(?:from|import)\s+["']ai["']/.test(code)) {
      errors.push(`${rel}: packages/shared 不得依赖 AI SDK；事件类型请使用 @answra/shared/schema`);
    }
    if (
      normalizedRel.startsWith("apps/agent/src/") &&
      !normalizedRel.startsWith("apps/agent/src/core/") &&
      /\bUIMessage(?:Chunk)?\b/.test(code) &&
      /(?:from|import)\s+["']ai["']/.test(code)
    ) {
      errors.push(`${rel}: UIMessage/UIMessageChunk 只允许出现在 apps/agent/src/core/`);
    }

    if (
      rel.replaceAll("\\", "/").startsWith("apps/desktop/src/main/") &&
      /new\s+BrowserWindow\s*\(/.test(code)
    ) {
      if (!code.includes("registerWindowSurface")) {
        errors.push(`${rel}: BrowserWindow 必须登记窗口角色和共享策略`);
      }
      if (!code.includes("prepareWindowToShow")) {
        errors.push(`${rel}: BrowserWindow 显示前必须调用 prepareWindowToShow`);
      }
    }

    // 4. 禁止在 src 里开启本地监听：进程间通信走 IPC / 管道 / utilityProcess，
    //    自建 server 会引入端口占用、被页面或其它进程探测、防火墙与签名负担，
    //    与"隐身"定位冲突。引入前先在 Note 里给出触发条件（见 docs/notes）。
    //    受控例外仅限桌面开发态与 CLI 的一次性 OAuth 环回回调，见白名单断言。
    if (/\bcreateServer\s*\(|\.listen\s*\(/.test(code)) {
      const exception = LOCAL_LISTENER_EXCEPTIONS.get(rel.replaceAll("\\", "/"));
      if (!exception) {
        errors.push(
          `${rel}: 禁止在 src 中开启本地监听（createServer/listen）；如需本地服务先补架构 Note`,
        );
      } else {
        for (const [_label, pattern] of Object.entries(exception)) {
          if (!pattern.test(code)) {
            errors.push(`${rel}: 本地监听例外缺少 ${_label} 断言（${pattern}）`);
          }
        }
      }
    }

    for (const match of code.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)) {
      const spec = match[1];

      // 6. 工具展示模型必须保持 host 无关：不得引入 React/DOM/Ink/图标/CSS/Agent 运行时。
      if (
        normalizedRel.startsWith("packages/ui/src/tool-presentation/") &&
        (spec === "react" ||
          spec === "react-dom" ||
          spec === "ink" ||
          spec === "lucide-react" ||
          spec.endsWith(".css") ||
          spec.startsWith("@answra/agent"))
      ) {
        errors.push(`${rel}: tool-presentation 必须保持 host 无关，禁止导入 "${spec}"`);
      }

      if (normalizedRel.startsWith("packages/ui/src/") && spec.startsWith("@answra/agent")) {
        errors.push(`${rel}: packages/ui/src 禁止依赖 apps/agent`);
      }

      // 7. remote 纯库必须保持平台/宿主无关：不得引入 React/DOM/Ink、Node、Electron 或其它应用。
      if (
        normalizedRel.startsWith("packages/remote/") &&
        (spec === "react" ||
          spec === "react-dom" ||
          spec === "ink" ||
          spec === "electron" ||
          spec.startsWith("node:") ||
          spec.startsWith("@answra/agent") ||
          spec.startsWith("@answra/cli") ||
          spec.startsWith("@answra/desktop") ||
          spec.startsWith("@answra/config") ||
          spec.startsWith("@answra/ui"))
      ) {
        errors.push(`${rel}: packages/remote 必须保持平台无关，禁止导入 "${spec}"`);
      }

      // 1. workspace 包导入：必须是该包 exports 声明的入口
      // 8. mobile 宿主只允许 shared/remote；core 不得沾 React Native/Expo。
      if (normalizedRel.startsWith("apps/mobile/")) {
        if (
          spec.startsWith("@answra/") &&
          !MOBILE_ALLOWED_WORKSPACE_PACKAGES.has(workspacePackageName(spec))
        ) {
          errors.push(
            `${rel}: apps/mobile 只能依赖 @answra/shared 与 @answra/remote，禁止导入 "${spec}"`,
          );
        }
      }
      if (
        normalizedRel.startsWith("apps/mobile/src/core/") &&
        (MOBILE_CORE_FORBIDDEN_SPECS.has(spec) ||
          spec.startsWith("expo") ||
          spec.startsWith("@expo/") ||
          spec.startsWith("@react-native") ||
          spec.startsWith("react-native"))
      ) {
        errors.push(`${rel}: apps/mobile/src/core 必须保持平台无关，禁止导入 "${spec}"`);
      }

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
          // 构建脚本只在打包期运行，不进入 renderer/preload 运行时产物。
          normalized.startsWith("apps/desktop/scripts/") ||
          normalized.startsWith("apps/agent/src/") ||
          normalized.startsWith("apps/agent/scripts/") ||
          normalized.startsWith("apps/cli/src/") ||
          normalized.startsWith("apps/cli/scripts/") ||
          // Node 宿主的远程适配只允许在 remote-node 内使用 Node 模块与原生依赖。
          normalized.startsWith("packages/remote-node/src/") ||
          // 共享客户端配置是 Node-only 库，只允许 desktop main 与 CLI 消费；
          // renderer/preload 仍禁止 node 内置。
          normalized.startsWith("packages/config/src/") ||
          // OS 凭据库是 Node-only：需要 node:module 以 CJS 解析原生 keychain 模块。
          normalized.startsWith("packages/credentials/src/");
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
