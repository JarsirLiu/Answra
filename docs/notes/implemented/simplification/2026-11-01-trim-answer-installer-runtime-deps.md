# Note：裁剪 answer 安装包的重复运行时依赖

状态：已实施

## 问题

answer 只保留答题、设置、账号、公告、更新和隐身，但安装包仍 104.9 MB。`app.asar` 中真正的应用产物只有 `out` + `dist` 约 3 MB，其余约 154 MB 是 `node_modules`：`pdfjs-dist`、`@napi-rs/canvas`、`lucide-react`、`shiki`、`react-dom`、`ai`、`@tiptap`、`katex` 等。它们已经被 Vite/esbuild 完整 bundle，却又作为生产依赖被 electron-builder 复制了一遍。`locales` 还带着约 37 MB 未使用的 Chromium 语言包。

面试 ASR 的疑问来自旧 full 包和依赖元数据：`sherpa-onnx-node` 仍在 `apps/desktop` 的 `dependencies` 里供 full 使用，answer 只是通过 `files` 排除。实际 answer 产物已用 7z 核验没有 `sherpa`/`resources/asr`，但依赖清单仍容易被误读为“答题包也带 ASR”。

## 涉及范围

- `apps/desktop/package.json`：生产/开发依赖归属、`electronLanguages`。
- `apps/desktop/scripts/audit-packaged-app.cjs`：最终 `app.asar` 的重复依赖守卫。
- `pnpm-lock.yaml`：依赖归类变化。
- 相关 Note：[安装包功能裁切与发布 Profile](../architecture/2026-11-01-answer-only-release-profile.md)、[answer Profile 设置面板宽度被视口钳制](../bug-fix/2026-11-01-answer-panel-width-fit-content-clamp.md)。

## 决定

`apps/desktop` 的生产依赖只保留真正运行时外置的三项：

- `electron-updater`：主进程 `require`，不能 bundle。
- `koffi`：原生模块，主进程与 preload 外置。
- `sherpa-onnx-node`：full 的面试 ASR 原生模块；answer 继续由 `files` 排除，并由 `afterPack` 检查不得出现。

`@answra/shared`、`@answra/ui`、`react`、`react-dom` 移到 `devDependencies`：renderer 由 Vite 打包，main/preload/worker 由 esbuild 打包，运行时不需要再从 `node_modules` 解析。`electron-builder` 不会复制开发依赖，因此 `@answra/ui` 的整棵生产依赖树不再进入安装包。

`build.electronLanguages` 固定为 `["zh-CN", "en-US"]`，去掉未使用的 Chromium 语言包。

`afterPack` 增加 `bundledOnlyScopes` / `bundledOnlyPackages` / `bundledOnlyPrefixes` 守卫：若 `@answra/*`、`@ai-sdk/*`、`@codemirror/*`、`@napi-rs/*`、`@shikijs/*`、`@tiptap/*`、`pdfjs-dist`、`lucide-react`、`react`、`react-dom`、`shiki`、`katex`、`prosemirror-*`、`rehype-*`、`remark-*` 等再次出现在 `app.asar/node_modules`，构建直接失败。

## 移除内容

- 从 answer 产物移除重复的 `@answra/ui` 及其 UI 依赖树（约 154 MB 未压缩）。
- 从 answer 产物移除 `@napi-rs/canvas` 原生解包（约 36 MB 未压缩）。
- 从 answer 产物移除未使用的 Chromium locales（约 36 MB 未压缩），只保留 `zh-CN` 与 `en-US`。

## 重新引入条件

- 某个包若从“构建期 bundle”改为“运行时 `require`/`import` 外置”，必须先把它移回 `dependencies`，并在 `afterPack` 守卫中删除对应规则；改完后必须重新审计 answer 与 full 两个产物。
- 新增 Chromium locale 需有明确的用户场景与实测，不得用“全语言更保险”作为理由。
- `sherpa-onnx-node` 只有在 full 仍需要本地 ASR 时保留；answer 不得因构建配置改动重新带入。

## 曾考虑的替代方案

- **继续提高 NSIS/7z 压缩级别：** 舍弃。`compression: "maximum"` 已是 electron-builder 的最高档；再压收益主要是 CPU 与解压时间，当前 25.5% 的压缩率不是瓶颈。
- **在 `files` 里逐包 allowlist 运行时 `node_modules`：** 舍弃。需要手工枚举 electron-updater、koffi 的整棵传递依赖，升级依赖就会漏包；先把 bundled-only 包移出生产依赖，让 electron-builder 自己计算运行时闭包更稳。
- **把 ASR 代码和 `sherpa-onnx-node` 从仓库彻底删除：** 舍弃。full 内部产物仍需要面试本地 ASR；answer 不执行这条链路，删除会破坏 full。
- **只保留约 62 个 Chromium locale 中的常用语言但继续打包 UI 依赖：** 舍弃。语言包只是 36 MB，重复的 `node_modules` 才是 154 MB 的主因，两者必须一起处理。

## 后果与防回退

- answer NSIS 从 104.9 MB 降到 74.0 MB；`app.asar` 从 128.7 MB 降到 6.2 MB，`app.asar.unpacked` 从 37 MB 降到 1.0 MB，`locales` 从 37.1 MB 降到 0.9 MB。
- `app.asar/node_modules` 只剩 19 个运行时包：`electron-updater`、`koffi`、`@koromix/koffi-win32-x64` 及其传递依赖。
- `sherpa-onnx-node` 仍出现在桌面包的依赖清单中服务 full；answer 的实际产物不含它。若未来要让 answer 的 `package.json` 元数据也完全干净，需要把 ASR 改为 full-only `extraResources` 注入，而不是当前 `files` 排除。
- 依赖归类是构建事实：把 bundled-only 包误加回 `dependencies` 会被 `afterPack` 守卫阻断，不需要靠人工量体积发现。
- full 仍包含 ASR 资源与 sherpa，体积优化只针对 answer；full 的内部产物不得上传公开更新源。

## 验证

- `pnpm verify` 通过（lint、typecheck、单测、架构守护）。
- `pnpm --filter @answra/desktop dist:win` 通过；`answer` 打包输入审计与最终 `app.asar`/resources 审计均通过。
- `pnpm --filter @answra/desktop dist:win:full` 也通过：full 仍包含 sherpa 与 ASR/VAD 资源，新增的 bundled-only 守卫未误伤 full。
- 7z 列出安装包：无 `sherpa-onnx-*`、无 `resources/asr`；`locales` 仅 2 个语言包。
- `app.asar/node_modules` 实测 19 个运行时包，`@answra/*`、`pdfjs-dist`、`@napi-rs/canvas`、`lucide-react`、`react`、`shiki` 均不存在。
- 体积实测：安装包 74.0 MB（原 104.9 MB），`app.asar` 6.2 MB（原 128.7 MB），`app.asar.unpacked` 1.0 MB（原 37.0 MB），`locales` 0.9 MB（原 37.1 MB）。
- 干净 Windows 虚拟机的安装、登录、答题、设置与更新实测仍需执行。
