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

项目 helper 与官方 librime 资产分开管理。清单 `rime-resources.json` 固定的 tag（当前 `answra-rime-host-v2.0.0`）触发 GitHub Actions 在 Windows x64 与 macOS universal runner 构建预编译 helper 并发布固定名称资产及 `SHA256SUMS`；准备脚本从该 tag 下载并校验 sidecar SHA-256。更新 helper 时必须先发布对应 tag 的 release，再改清单；release 缺失或摘要不符时准备流程 fail-closed 失败。开发和打包机器不编译 C++。

## 流程变化

`pnpm bootstrap` 执行 `ime:prepare` 下载并校验当前平台资源。Windows bootstrap 通过 Node 直接调用 Corepack 的 pnpm CLI，所有子进程均不启用 shell。发布构建也必须在打包前完成 bootstrap。下载使用系统 `curl` 跟随上游重定向并流式写入缓存，连接阶段最多等待 60 秒、单个请求最多运行 10 分钟，并重试瞬时连接/服务错误；下载后仍必须通过 SHA-256 校验。更新上游资源时同步修改 `rime-resources.json` 的固定版本、URL 和 SHA-256；更新 helper 时使用新的 release tag，不能覆盖既有 tag。

## 曾考虑的替代方案

- **要求协作者手动下载并复制文件：** 舍弃。文件容易漏项或混用版本，且无法在 CI 和新机器上复现。
- **在 `pnpm dev` 或 bootstrap 阶段调用 CMake 编译 helper：** 舍弃。会让开发机依赖平台编译工具，违反预编译资源约定；helper 改由受控的 Windows/macOS 发布 workflow 生成。
- **把 DLL、词库或 helper 提交到 Git：** 舍弃。平台运行库、词库体积和更新频率不适合放进源码历史；资源保存在忽略目录并从固定来源下载。
- **单个下载只等待 120 秒：** 舍弃。实测 Release 文件传输速度波动，较大的固定资源可能在两分钟内无法下载完成；延长到 10 分钟仍有界，且保留有限重试及摘要校验。
- **递归查找目录时在每个分支失败即抛错：** 舍弃。deps 归档含多个顶层目录；未命中的分支必须返回空结果，让搜索继续检查其余目录。
- **继续使用 Node `fetch` 下载 GitHub Release：** 舍弃。Windows Node 22 对 `github.com` 的连接持续触发内置 10 秒连接超时，而同机 `curl.exe` 能访问；改用系统 curl 可使用已验证可用的下载路径，并支持流式落盘。
- **通过 `shell: true` 启动 Windows 子进程：** 舍弃。Node 发出 DEP0190 弃用警告；Corepack pnpm CLI 可由当前 Node 直接启动，Electron 安装脚本本身也是 Node 程序，无需 shell。

## 后果与防回退

首次 bootstrap 需要网络及系统 `curl`（Windows、macOS、Linux）；Windows 还需通过 Corepack 安装 pnpm，或提供 `npm_execpath` 指向 pnpm CLI。固定上游归档 hash 不匹配时必须立即失败，不能使用损坏下载或回退到系统 IME。Helper release tag 必须先由 workflow 创建；缺少 release 或 sidecar 摘要时准备流程失败。`resources/rime` 和 `.cache-rime` 保持 Git 忽略，不应因资源准备而暂存其中的文件。

## 验证

- 已从 GitHub API 核对 librime `1.17.0` 四个 Windows/macOS runtime/deps 资产的 SHA-256，并下载复算一致。
- 已下载并复算五个固定 commit 归档的 SHA-256。
- Windows 慢速 Release 链路实测中，7.1 MiB runtime 与 3.5 MiB deps 均在延长超时后下载并通过既有 hash 校验。
- Windows Node 22 环境下，修正目录递归搜索并改用 curl 后，`pnpm --filter @answra/desktop ime:prepare` 全流程通过；helper sidecar 和下载资产均完成 SHA-256 校验，运行库、OpenCC 和词库资源准备成功。
- Windows 执行 `pnpm bootstrap` 时验证了移除 `shell: true` 后不再输出 DEP0190；后续一次运行在 helper sidecar 请求处遇到 GitHub 连接重置，属于外部网络失败。
- 已推送 tag `answra-rime-host-v2.0.0`（协议 v2）并生成 release 与 `SHA256SUMS`；Windows 本机重跑 `ime:prepare` 成功下载并校验官方 helper，握手输出 `protocolVersion: 2`、`available: true`。协议升级必须与 release 交付绑定的约束，以及此前 release 缺失导致内置 IME 回退系统输入法的复盘见 `../bug-fix/2026-10-16-ime-helper-protocol-v2-release-unpublished.md`。
- 待完成：macOS 打包加载与实机输入法隔离验证。
