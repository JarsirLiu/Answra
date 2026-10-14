# Note：内置 Rime 资源固定下载流程

状态：已实施

## 问题

`ime:prepare` 过去只检查 `resources/rime` 目录，开发机需要手工下载和复制 librime、词库及 helper。新 checkout 或 CI 无法按统一步骤准备资源，也无法验证手工放入文件是否来自预期上游版本。

## 涉及范围

- 代码/模块：`apps/desktop/native/rime-resources.json`、`apps/desktop/scripts/prepare-rime.mjs`、`scripts/bootstrap.mjs`、`.github/workflows/rime-host-release.yml`。
- 工程流程：开发 bootstrap、Windows/macOS 打包前资源准备、项目 helper 发布。
- 相关 Note：`docs/notes/implemented/architecture/2026-10-14-embedded-rime-ime.md`。

## 决定

资源清单固定 librime `1.17.0` 官方平台包及 deps 包 URL/SHA-256，并固定 `rime-prelude`、`rime-luna-pinyin`、`rime-stroke`、`rime-essay`、`rime-easy-en` 的 Git commit、归档 URL/SHA-256。`ime:prepare` 自动下载当前平台需要的包，校验后解压官方 schema、词典、OpenCC 数据和许可证文件到被 Git 忽略的运行目录。Windows 7z 解压使用 workspace dev dependency `7zip-bin`；macOS universal 运行库保留官方 `dist/lib` 目录结构。

项目 helper 与官方 librime 资产分开管理。tag `answra-rime-host-v1.0.0` 触发 GitHub Actions 在 Windows x64 与 macOS universal runner 构建预编译 helper 并发布固定名称资产及 `SHA256SUMS`；准备脚本从该 tag 下载并校验 sidecar SHA-256。开发和打包机器不编译 C++。

## 流程变化

`pnpm bootstrap` 执行 `ime:prepare` 下载并校验当前平台资源。发布构建也必须在打包前完成 bootstrap。更新上游资源时同步修改 `rime-resources.json` 的固定版本、URL 和 SHA-256；更新 helper 时使用新的 release tag，不能覆盖既有 tag。

## 曾考虑的替代方案

- **要求协作者手动下载并复制文件：** 舍弃。文件容易漏项或混用版本，且无法在 CI 和新机器上复现。
- **在 `pnpm dev` 或 bootstrap 阶段调用 CMake 编译 helper：** 舍弃。会让开发机依赖平台编译工具，违反预编译资源约定；helper 改由受控的 Windows/macOS 发布 workflow 生成。
- **把 DLL、词库或 helper 提交到 Git：** 舍弃。平台运行库、词库体积和更新频率不适合放进源码历史；资源保存在忽略目录并从固定来源下载。

## 后果与防回退

首次 bootstrap 需要网络。固定上游归档 hash 不匹配时必须立即失败，不能使用损坏下载或回退到系统 IME。Helper release tag 必须先由 workflow 创建；缺少 release 或 sidecar 摘要时准备流程失败。`resources/rime` 和 `.cache-rime` 保持 Git 忽略，不应因资源准备而暂存其中的文件。

## 验证

- 已从 GitHub API 核对 librime `1.17.0` 四个 Windows/macOS runtime/deps 资产的 SHA-256，并下载复算一致。
- 已下载并复算五个固定 commit 归档的 SHA-256。
- 待完成：推送 workflow 后创建 tag `answra-rime-host-v1.0.0`；release 生成后才能在全新 Windows/macOS 环境完整执行 `ime:prepare` 并验证 helper 打包加载。
