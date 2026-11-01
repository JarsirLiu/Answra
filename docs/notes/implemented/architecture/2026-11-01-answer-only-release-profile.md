# Note：安装包功能裁切与发布 Profile

状态：已实施

## 问题

原有桌面构建只有一套完整 renderer、main、preload 和 Agent worker 入口。`interviewAvailable` 只能改变界面显示，不能裁掉功能模块、IPC、原生依赖和模型资源。只改入口可见性会把尚未发布的能力继续交付给安装包用户。

## 涉及范围

- `packages/shared/src/release.ts`、`packages/shared/src/release-features.json`：发布契约与封闭功能目录。
- `apps/desktop/release-profiles.json`、`scripts/release-profile.mjs`、`scripts/build-electron.mjs`、`vite.config.ts`：构建选择、清单生成和按 Profile 选择组合根。
- `packages/ui`、`apps/desktop/src/main`、`apps/desktop/src/preload`、`apps/agent`：renderer、IPC、preload 与 worker 的功能边界。
- electron-builder 配置生成和构建图/最终 `app.asar` 审计。
- 相关 Note：[生产安装包构建加固与逆向边界](../../implemented/architecture/2026-10-29-production-package-hardening.md)。会员能力目录、账号权益和远端开关不参与本决策。

## 决定

采用构建期 `ReleaseProfile`、显式包含/排除清单、独立 Profile 组合入口和构建审计。当前 Profile 为 `answer` 与 `full`：`answer` 是公开发布入口；`full` 供内部验证使用，electron-builder 为它生成独立 `appId`、安装名、产物名和输出目录。

共享功能目录列出 `answer`、`chat`、`workspace`、`interview`、`settings`、`account`、`announcements`、`updates`、`stealth`。每份 Profile 必须对目录中的每项功能明确写入 `include` 或 `exclude`；未知、重复、缺失、空清单及缺少 `--profile` 都会失败，不会回退到 full。增加功能 ID 时必须同步扩展所有 Profile 的决定，测试会检查 TypeScript 契约与构建目录一致。

`answer` 包含答题和必要基础设施；排除通用对话 UI/runtime、工作区与笔记、面试、VAD/ASR、会议占位入口及 sherpa 原生依赖。答题 runtime 保留模型请求与答题链路，工具注册由 worker 组合根注入；answer worker 不装配聊天 profile、工作区工具或面试处理器。`full` 使用聊天 runtime、工作区组合、面试 worker 和原生依赖。

`build:answer` 与 `build` 分别构建 answer 和 full。开发态明确选择 full。main、preload、Agent worker 使用 Profile 对应入口；renderer 用构建期常量裁掉分支，工作区另处于独立 lazy chunk，answer 构建不生成它。preload 的 answer 入口只暴露答题、设置、账号、更新、截图及共享窗口功能 API。

`ReleaseManifest` 记录 schema 版本、Profile 与包含功能，写入 `out/release-manifest.json` 并进入 `app.asar`。它是构建事实，不作为运行时授权凭据。answer main 对一般聊天 IPC 额外拒绝，answer worker 也拒绝聊天和面试命令。

构建审计读取 esbuild metafile 与 Vite 输出模块清单，校验选中入口、Profile manifest 和排除功能模块；打包输入审计还拒绝自有 bundle 里的源码及 source map。electron-builder 配置按 Profile 生成：answer 移除 `extraResources`、原生依赖解包项，并排除 sherpa 包；full 加入 VAD/ASR 资源和 sherpa 解包。`afterPack` 检查真实 app 目录里的 manifest、资源目录与原生包。

## 模块边界

- `packages/shared` 持有跨包 Profile/FeatureId/Manifest 契约，不包含构建逻辑。
- `packages/ui` 保留共享答题/reply 工作流；聊天面板与工作区面板各自处于功能模块，Profile 组合根决定是否进入产物。
- `apps/desktop/src/main` 只在 full 组合时装配面试 IPC 与工作区服务；preload answer 入口不导出这两域的 API。
- `apps/agent/src/conversation/runtime.ts` 保持答题运行时；通用聊天 profile 运行时拆到 `chatRuntime.ts`。工具构造由 Agent 组合根注入，answer 不导入工具注册表。
- 构建脚本负责选择入口、生成清单和审计；不实现运行时权益或服务端开关。`apps/desktop/scripts` 只在打包期运行，架构守护允许其使用 Node 内置模块；renderer/preload 的运行时隔离规则不变。

## 曾考虑的替代方案

- **只隐藏 UI 或关闭运行时 flag：** 舍弃。IPC、worker、依赖和资源仍会进入包。
- **把未发布功能改成动态 import：** 舍弃。延迟 chunk 仍随安装包分发；只有 Profile 构建入口根本不引用的模块才会被排除。工作区 lazy chunk 只用于 full 包内延迟加载，answer 构建审计确认该 chunk 不存在。
- **只维护 FeatureId 表：** 舍弃。配置表不能裁剪 bundler 依赖图，必须与入口拆分、依赖注入和构建图审计配套。
- **只靠 ASAR、混淆或 source map 策略：** 舍弃。它们不能证明功能模块未交付，也不能阻止已交付代码被逆向。
- **复制完整应用或 Agent runtime：** 舍弃。会导致答题和共享生命周期实现分叉；保留共用 runtime，通过工具工厂与功能组合根分离聊天、工作区和面试。

## 后果与防回退

- 裁切能减少安装包交付内容，不能保护包内代码不被逆向。
- 新功能必须加入共享目录，并在每个 Profile 中明确包含或排除；resolver、Vite 配置和测试缺一项都会阻断构建或门禁。
- 最终 ASAR 中第三方依赖可能带有 `.d.ts` 或 source map；审计以自有 bundle 依赖图检查功能裁切，并单独检查最终包的原生依赖、模型资源和 manifest。
- full 包目前是内部产物，不得上传到公开更新源。启用其公开分发前，须单独配置并验证更新源与升级兼容性。
- Profile 无法远程开启未随包分发的功能；该功能需重建并重新分发包含它的安装包。

## 验收标准

- answer bundle 与 worker 依赖图中不含通用聊天 profile、工作区工具/面板、面试处理器及其模型适配代码。
- answer 最终 app 目录不含 VAD/ASR 资源或 sherpa 原生依赖；manifest 与选择的 Profile 一致。
- full 内部配置使用隔离的 appId、安装名、输出目录，并包含 VAD/ASR 与 sherpa。
- `pnpm verify`、`pnpm notes:check` 通过。
- 自动化门禁通过后，answer Windows 安装包可在干净 Windows 虚拟机实测登录、截图答题、回复条、设置、公告、更新和隐身；full 另测面试与工作区。

## 验证

- `releaseProfile.test.ts` 覆盖缺省、重复、未知 Profile 和每项功能必须有明确决定。
- `ConversationRuntime` 与 Agent host 测试覆盖答题、通用聊天 runtime 和 worker 行为。
- answer renderer/main/preload/worker 构建依赖图与 full 构建依赖图均执行 `audit:packaged`。
- `pnpm verify` 与 `pnpm notes:check` 在本变更上通过。
- `dist:win` 成功生成 answer NSIS 安装包；`app.asar` 内 manifest 为 `answer`，不含 sherpa 原生依赖，`afterPack` 审计通过。Windows 安装界面与产品行为的干净虚拟机实测尚未执行。

## 风险

- full renderer 的工作区 lazy chunk 仍较大；这是 full Profile 的包内容，后续可单独优化体积。
- 不同 Profile 的组合入口可能行为漂移；共享答题链路继续由同一 runtime 与 UI 组件提供，功能 UI 与 worker 要有各自测试。
- electron-builder 与 pnpm 对 optional native dependencies 的处理依赖锁文件和打包配置；`afterPack` 审计失败时不得发布。
