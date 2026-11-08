# Note：Answer Release 直接列出跨平台安装包

状态：已实施

## 问题

`answer-latest` 只构建 macOS，GitHub Release 页面没有 Windows 安装包。Release 正文没有安装包直链，用户需要展开 Assets 自行识别文件；由于 Answer release 是 prerelease，GitHub 仓库首页仍将旧 Rime v2.0.0 显示为 Latest。

## 涉及范围

- 代码/模块：`.github/workflows/answer-macos.yml`（工作流名称保留以避免无关重命名）。
- UI/进程/协议/持久化表面：GitHub Actions 构建产物与 GitHub Release 页面。
- 相关 Note：[Answer-only release profile](../architecture/2026-11-01-answer-only-release-profile.md)

## 决定

Answer Release 使用独立 Windows 和 macOS 构建 job，两个平台均成功后由单一 publish job 汇总。发布前必须验证 Windows x64 `.exe`、macOS arm64 `.dmg` 和 macOS x64 `.dmg` 均存在；Release 正文直接列出三种下载链接，Assets 保留完整构建文件（包括 macOS zip 和自动更新元数据）。该 Release 设为 GitHub Latest，旧 Rime Release 保持为历史版本，不删除其资产。

## 流程变化

- main push 或手动触发后，Windows 与 macOS 在各自原生 runner 上独立构建 Answer 包。
- publish job 只在所有构建成功后下载并验证安装包，再创建或更新 `answer-latest`。
- Release 正文明确列出 Windows x64、macOS Apple Silicon 和 macOS Intel 的安装包链接；用户不必从 Assets 中寻找安装器。
- 发布后将 Answer release 标记为非 prerelease 的 Latest；应用内更新仍由既有 COS 更新源负责。

## 曾考虑的替代方案

- **只调整 Release 标题和说明：** 不会产生 Windows 安装包，也不能保证目标资产存在，舍弃。
- **删除旧 Rime Release 资产：** 会破坏已有 Rime 用户的下载链接；将 Answer 标记为 Latest 后旧 release 自然位于历史列表，保留资产。

## 验收标准

- 可观察结果：Release 正文直接显示三种平台安装包链接，Windows/macOS 构建均成功后才发布。
- 自动化验证：工作流对三种安装包执行非空校验；仓库 Note 检查和全量门禁通过。
- 需要的实机验证：GitHub Actions 真实完成 Windows 和 macOS 构建，并确认 Release 页面链接可下载。

## 后果与防回退

- macOS 安装包仍为 arm64 与 x64 两个 `.dmg`；Windows 当前只发布 x64 NSIS `.exe`。
- publish job 是唯一修改 `answer-latest` 的 job；不得在单个平台 job 先行更新 Release，以免产生不完整的下载页。
- 仓库主页显示的 Latest 与应用内更新源是两件事；应用更新继续使用既有 COS 配置，不读取 GitHub Latest。
- 不删除 Rime 旧 release 或其资产。

## 验证

- 工作流静态检查与 YAML 解析：待本地验证。
- `pnpm notes:check`：待本地验证。
- `pnpm verify`：待本地验证。
- GitHub Actions 跨平台构建及 Release 页面下载：推送后验证。
