# Note：Answer 版 macOS 自动构建与 Electron 下载重试

状态：已实施

## 问题

Windows 开发机无法本地构建 macOS 安装包。原有发布工作流需要手动触发或打版本标签，并且一次同时构建 Windows 与 macOS；依赖安装阶段 Electron 下载偶发 HTTP 504 时，整个构建直接失败。

## 涉及范围

- 代码/模块：`.github/workflows/answer-macos.yml`、`.github/workflows/release.yml`、根 `package.json` 的 `dist:mac` 入口。
- UI/进程/协议/持久化表面：无运行时行为变化；只影响构建与分发。
- 相关 Note：[GitHub Actions 双平台发布流水线](./2026-11-01-github-release-pipeline.md)。

## 决定

新增独立的 Answer macOS 工作流：`main` 推送和手动触发都会在 `macos-14` runner 上执行 `pnpm dist:mac`，上传 DMG、ZIP、blockmap 和更新清单作为 GitHub Actions 工件。Electron 依赖安装最多重试三次，并显式使用仓库已有的 Electron 与 electron-builder 镜像。

正式发布仍由 `release.yml` 的 tag/手动流程负责；本工作流不上传 COS、不创建 GitHub Release，避免验证构建产生正式发布副作用。

旧 `Release` 手动入口保留用于平台验证和正式上传，但其默认平台也设为 macOS；两条工作流的 Electron 依赖安装都最多重试三次。

## 流程变化

- `main` 推送和手动触发 `Build Answer macOS` 都只运行 `macos-14`。
- 手动触发 `Release` 默认只运行 macOS；需要 Windows 或双平台时必须显式选择。推送版本 tag 仍运行两个平台。
- 构建命令固定为 `pnpm dist:mac`，该命令使用 `answer` profile，上传 DMG、ZIP、blockmap 和更新清单作为 30 天 Actions 工件。
- 两条工作流中的 Electron 依赖安装最多尝试三次，并设置 Electron 与 electron-builder 二进制镜像。

## 曾考虑的替代方案

- **只使用原有 `release.yml`：** 舍弃。此前手动触发会默认同时启动 Windows 与 macOS，容易误跑 Windows job。
- **在 Windows 本地交叉构建 macOS：** 舍弃。Electron 原生打包、签名和资源审计不适合依赖 Windows 交叉构建，无法提供可靠的 macOS 工件。
- **只增加镜像不重试：** 舍弃。镜像本身仍可能瞬时超时，不能覆盖本次已观察到的失败模式。

## 验收标准

- 可观察结果：`Build Answer macOS` 运行后出现 `answra-answer-macos` 工件，包含 Answer 版 DMG 和 ZIP。
- 自动化验证：`pnpm notes:check`、`pnpm verify`、`git diff --check` 通过。
- 需要的实机验证：GitHub macOS runner 首次真实运行完成安装包构建；本地 Windows 无法替代该验证。

## 风险

每次 `main` 推送都会消耗一次 macOS runner，并保留 30 天工件。构建产物是未公证、未上传 COS 的验证包；正式分发仍需使用发布工作流和相应凭证。镜像连续不可用时，三次重试仍会失败并保留明确的安装日志。

## 后果与防回退

- 新增平台或正式发布仍应修改 `release.yml`，不能把上传 COS 逻辑复制到验证工作流。
- 手动验证应选择 macOS；推送正式版本 tag 才会默认构建双平台。
- 工作流必须保持 `pnpm dist:mac`，该脚本固定使用 `answer` profile。
- Electron 下载失败时必须继续重试，不能恢复为单次 `pnpm install`。

## 验证

- `pnpm notes:check`
- `pnpm verify`
- `git diff --check`
- 未执行：GitHub macOS runner 的真实打包；推送后的 Actions 运行日志是该平台验证的唯一证据。
