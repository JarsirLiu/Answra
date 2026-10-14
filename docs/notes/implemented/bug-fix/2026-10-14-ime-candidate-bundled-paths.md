# Note：修正候选窗打包路径

状态：已实施

## 问题

独立候选窗创建成功，Rime 也能返回中文候选，但候选条一直不显示。Windows 实测中，输入 `ni` 得到 `composing: true`、5 个候选；候选窗口随后因输入框失焦保持隐藏。

## 涉及范围

- 代码/模块：`apps/desktop/src/main/ime/imeCandidateWindowController.ts` 及其 controller 测试。
- UI/进程/协议/持久化表面：Electron main bundle、候选 BrowserWindow preload 和 renderer 页面加载。
- 相关 Note：[IME 候选条使用独立原生窗口](../feature/2026-10-14-ime-candidate-native-window.md)。

## 根因

`build-electron.mjs` 将 main 入口及其依赖打包为 `out/main/index.cjs`，运行时 `__dirname` 是 `out/main`。候选 controller 按源码目录层级计算路径，preload 多退了一层，指向不存在的 `apps/desktop/preload/index.cjs`；候选 renderer 因而没有 `window.answra` preload API，不能发 Ready，主进程按握手约定不会显示候选窗。生产页面路径也多退了一层。

## 决定

候选窗口资源路径以编译后 main bundle 所在目录为基准，并将这个 bundle 布局作为可测试契约。

## 修复

- 从编译后 main bundle 目录解析 preload 为 `../preload/index.cjs`，生产 renderer 页面为 `../../dist/index.html`。
- 集中解析这两个路径，并测试典型 `out/main` 目录下的最终路径，防止再以源码目录层级推算 bundle 运行路径。
- 监听 Electron `preload-error`，记录候选窗口 preload 的实际加载错误。

## 曾考虑的替代方案

- **取消 renderer Ready 握手并强行显示窗口：** 这会绕过状态监听已安装的保证，且无法修复缺失的 bridge；保留握手并修正路径。
- **改用 `app.getAppPath()` 拼接所有资源路径：** 可行，但 main bundle 与 preload 已有稳定的相邻输出目录；使用相对 bundle 路径更直接，并由编译布局测试锁定。

## 后果与防回退

- 修改 main 入口打包目录或 preload 输出结构时，必须同步更新路径解析函数及其测试。
- 未加载 preload 时候选窗仍保持隐藏，这是有意的 fail-closed 行为；日志会报告 `[ime-candidate] preload failed`。

## 验证

- Windows 用户日志证明输入事件到达 Rime，`KeyN`、`KeyI` 返回 composing 和 5 个候选；隔离 helper 测试确认简体中文方案有效。
- `resolveImeCandidateWindowPaths` 回归测试验证 `out/main` 对应的 preload 与 renderer 位置。
- 完整 `pnpm verify` 与桌面生产构建通过；Windows 候选窗显示仍需用户重启开发进程后实测确认。
