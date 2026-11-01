# Note：afterPack 产物审计写死 Windows 资源路径

状态：已实施

## 问题

`apps/desktop/scripts/audit-packaged-app.cjs` 把打包产物路径拼成 `<appOutDir>/resources/...`，这只在 Windows/Linux 成立。macOS 的产物是 `Answra.app/Contents/Resources/...`，因此 mac 打包会在 `afterPack` 阶段全部判为"缺少 asar / 资源"而失败，或在 answer Profile 下把不存在的路径误判为"包含面试模型资源"。

## 涉及范围

- 代码/模块：`apps/desktop/scripts/audit-packaged-app.cjs`。
- UI/进程/协议/持久化表面：无；仅打包时审计。
- 相关 Note：[GitHub Actions 双平台发布流水线](../process/2026-11-01-github-release-pipeline.md)。

## 决定

审计脚本按 `context.electronPlatformName` 推导唯一的资源根目录 `resourcesDir`，所有产物路径检查都从该目录派生；Windows 分支路径与行为保持一致，mac 分支使用 `Contents/Resources`。

## 根因

审计脚本按 Windows 布局写死资源目录，没有区分 `context.electronPlatformName`；mac 的 bundle 目录层级（`<product>.app/Contents/Resources`）未被考虑。

## 修复

- 新增 `resourcesDir`：`darwin` 时为 `join(appOutDir, \`${productFilename}.app\`, "Contents", "Resources")`，其余平台保持 `join(appOutDir, "resources")`。
- `app.asar`、`vad`/`asr` 资源检查、`app.asar.unpacked` 依赖检查统一改用 `resourcesDir`。
- 顺带把 `afterPack` 改为组合钩子 `scripts/after-pack.cjs`（审计 + macOS ad-hoc 签名），保证签名是 bundle 最后一次修改。

## 曾考虑的替代方案

- **给 audit 传 `--platform` 参数由调用方指定：** 舍弃。electron-builder 的 hook context 已包含 `electronPlatformName` 与 `appInfo.productFilename`，再加一层参数就是双事实来源。
- **在 mac 上跳过该审计：** 舍弃。answer/full 的产物约束（不含 sherpa、不含模型资源）在 mac 上同样必须成立，跳过等于让 mac 包绕过发布门禁。

## 验收标准

- 可观察结果：mac 打包时 `afterPack` 审计通过并打印 `✓ answer 最终 app.asar 与 resources 审计通过`。
- 自动化验证：Windows 打包路径行为不变（`pnpm dist:win` 走原有分支）；mac 分支需在 Actions 首次运行中验证。
- 需要的实机验证：macOS 上确认审计未误报。

## 风险

- 若某个 mac 版本 electron-builder 改变 `appOutDir` 语义（如 universal 构建的中间目录），路径需再次核对；当前只覆盖 `--arm64 --x64` 的非 universal 构建。

## 验证

- `pnpm lint`、`pnpm notes:check` 通过。
- 未执行：macOS 打包（当前环境为 Windows）。首次 `Release macOS` 运行日志是唯一有效证据，需在运行后补记。

## 后果与防回退

- 任何新增的产物路径检查都必须从 `resourcesDir` 派生，禁止再出现 `join(context.appOutDir, "resources", ...)` 字样，否则 mac 分支会以同样方式失效。
