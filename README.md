<div align="center">

# Answra

**面向工作与学习场景的本地优先 AI 助手**

在桌面端准备面试、辅助会议，在终端中协作编程，并通过安全的 P2P 连接管理远程设备。

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.13-111827?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-11.9-F69220?style=flat-square&logo=pnpm&logoColor=white)](https://pnpm.io/)
[![License](https://img.shields.io/badge/license-PolyForm%20Noncommercial-111827?style=flat-square)](LICENSE)

</div>

## 产品演示

<!-- 视频发布后，将下方占位内容替换为视频链接或 GitHub 支持的演示资源。 -->

<div align="center">

*产品演示视频即将上线*

</div>

## 快速导航

[产品能力](#产品能力) · [开始开发](#开始开发) · [架构概览](#架构概览) · [常用命令](#常用命令) · [参与开发](#参与开发)

## 为什么是 Answra

Answra 把桌面辅助、终端编码和远程连接放在同一个本地优先工作流中。它不要求你切换多个工具，也不把个人模型配置和工作数据交给云端托管。

| 场景 | 你可以用 Answra 做什么 |
| --- | --- |
| **面试准备** | 用本地语音识别进行模拟面试，整理回答建议与知识点 |
| **屏幕问答** | 截取应用内区域，让 AI 结合图片快速分析技术问题 |
| **编程协作** | 在终端中让 Coding Agent 搜索代码、修改文件并执行命令 |
| **远程工作** | 通过 P2P 连接控制远程 CLI，并使用本地密钥保护访问 |

## 产品能力

### 桌面助手

- **实时面试准备**：基于本地 VAD/ASR 识别语音，模拟面试场景并生成回答建议。
- **屏幕智能问答**：截取应用内区域或上传图片，实时分析技术问题和知识点。
- **低干扰工作流**：通过 Electron 窗口捕获保护减少屏幕共享或录屏时的干扰。
- **悬浮条界面**：使用模式选择、功能面板和设置三段式导航，按需展开对话、笔记与参考资料。

### 终端 Coding Agent

- **代码协作**：运行 `answra code` 进入 TUI，支持文件读写、ripgrep 搜索和 shell 执行。
- **会话管理**：多会话并行，支持 SQLite 持久化、列表、恢复和删除。
- **模型配置**：通过 `/config` 管理模型端点与 API Key，密钥使用 OS keychain 存储。
- **高效交互**：提供 `/help`、`/sessions`、`/model`、`/summarize` 等 Slash 命令，以及命令提示和参数补全。
- **上下文控制**：自动压缩超限对话，支持手动摘要和 token 预算可视化。

### 远程操控

- **P2P 连接**：基于 WebRTC DataChannel，无需中继服务器。
- **设备配对**：使用 `answra remote host` 开启桌面宿主；手机 controller 在 `apps/mobile`，Phase 0 只落路由与端口骨架。
- **安全访问**：访问密钥在本地受保护存储，并支持密钥轮换。

## 工程基础

- **本地优先**：模型配置、会话记录和凭据按职责分离，本地存储，API Key 不进入共享配置文件。
- **跨客户端 Agent**：同一套 Agent 运行时同时服务桌面 utility process 与 CLI 独立进程。
- **可靠数据层**：SQLite 使用 baseline + append-only migration ledger，并覆盖升级、幂等性和回滚测试。
- **类型安全边界**：通过 `ChannelMap` 维护 IPC 频道映射，隔离 main、preload 与 renderer。
- **离线语音能力**：使用 TEN VAD + Paraformer ASR，语音识别链路可完全离线运行。
- **架构守护**：自动检查深导入、依赖环和平台边界越界。

工程决策、功能方案、缺陷复盘和架构边界统一记录在[工程 Note](docs/README.md)。

## 开始开发

### 环境要求

- Node.js 22.13 或更新版本（pnpm 11.9 的最低要求）
- CLI 运行时目标为 Node 22.13；安装包复用 Electron 35.0.0 内置的 Node 22.14，不额外携带 Node sidecar
- pnpm 11.9.0，建议通过 Corepack 管理
- Windows 可运行原生 Electron 桌面窗口；其他平台可通过 `pnpm dev:web` 预览 renderer

### 启动项目

```powershell
corepack enable
pnpm bootstrap
pnpm --filter @answra/desktop vad:prepare
pnpm --filter @answra/desktop asr:prepare
pnpm dev
```

`pnpm bootstrap` 是统一的环境初始化入口：安装 workspace 依赖，并校验/通过 npmmirror 镜像补齐 Electron 二进制，避免 `pnpm dev` 启动时才临时下载卡住。`pnpm dev` 默认按 answer Profile 启动，和公开发布安装包保持同一套功能裁切；需要聊天或面试时使用 `pnpm dev:full`。两者都会同时启动 Vite 和 Electron，`pnpm dev:web` / `pnpm dev:web:full` 可只启动浏览器预览。桌面开发窗口使用 5180 端口；端口被占用时命令会报错退出，不会静默换端口。

面试语音运行还需要 TEN VAD 与 Paraformer 模型。上面两条 prepare 命令会下载并校验资源；ASR 模型约 82 MB，支持断点续传。`bootstrap` 不包含这两类语音资源。

### 质量检查

```powershell
pnpm verify   # lint + typecheck + db:check + test + architecture:check（Note 检查仅提示，不阻断）
pnpm build
```

## 架构概览

pnpm workspace monorepo：包间依赖只走 `workspace:*` 与各包 `exports` 声明的公开入口；IPC 频道与载荷类型集中在 `@answra/shared`；渲染层 UI 与平台能力（DesktopBridge）解耦，`packages/ui` 不允许直接接触 Electron。

```text
packages/shared        跨进程契约：IPC 频道常量 + ChannelMap 类型、环境变量常量、领域类型
  src/schema/events.ts Agent 全量事件目录与唯一 envelope；delta 不属于 durable 候选
  src/schema/status.ts Agent run/step 状态词汇与快照
  src/schema/connection.ts Agent 连接状态词汇与稳定失败码（桌面/CLI 共用）
  src/schema/session.ts 会话历史 scope、摘要、分页页对象与查询类型（桌面/CLI 共用）
packages/config        Node-only 共享客户端配置：非 secret 本地模型地址/模型 ID、原子读写与迁移
packages/credentials   Node-only 共享 OS 凭据：本地模型 API Key 的 keychain 读写，fail-closed
packages/tts           Node-only 宿主无关的 TTS 合成核心：协议适配器、Markdown 净化、切句策略与错误归一；不持凭证、不播放
packages/remote        平台无关远程连接核心：帧/信令 schema、host/controller 会话、访问密钥、稳定错误码与 fake ports
packages/skills        内置 Agent Skill 内容包：只有 Markdown 与资源，无运行时代码
packages/ui            悬浮条与面板的全部业务 UI（React），含组件测试
apps/desktop           Electron 桌面壳
  src/main             主进程：窗口管理、按领域拆分的 IPC handler
  src/main/conversation 对话 IPC、会话历史 IPC、worker 注入与 SQLite store 装配
  src/main/connection  Agent 连接状态 IPC、窗口广播与 Electron worker host 适配
  src/preload          contextBridge 桥（window.answra）
  src/renderer         薄渲染层：仅挂载 <FloatingBarApp/>
apps/cli              独立终端宿主：coding Bot 的 CLI 入口、模型配置、远程密钥、TUI 与非 TTY 流式输出
  src/cli              命令分派、code/config/remote 用例、依赖端口与 help/error
  src/config           argv 语法与工作区校验；不读写配置
  src/model            CLI 模型设置域：选择、优先级与应用服务端口
  src/session          单活动 run 的 CodingSession 用例：新建/恢复/列表/删除
  src/adapters         @answra/config 共享文件实现与 @answra/agent/composition 端口映射；keychain 由 main 注入
  src/remote           远程 host 适配与 CLI 本地密钥存储
  src/presentation     Agent 事件与模型摘要到文本/工具行的纯投影
  src/tui              TUI 组合根：app/ 根布局与 view store，transcript/ 虚拟列表与工具展示，composer/ 输入，chrome/ 状态行，commands/ slash 命令与 access，panels/ 面板，notices/ 通知中心，interaction/ 指针/选区/剪贴板
  src/transport        stdin/stdout/stderr 适配
apps/mobile            Android-first Expo/RN 移动端 controller（Phase 0 骨架：路由、端口与 fake，真实 auth/WebRTC 待接入）
  src/app              Expo Router 路由与页面装配
  src/core             平台无关连接/端口/投影；禁止 RN/Expo
  src/transport        RN WebSocket、react-native-webrtc、NetInfo、AppState 适配
  src/auth             OAuth PKCE、深链回调与 token 刷新
  src/credentials      expo-secure-store 的 auth token 与 host key 适配
  src/state            移动视图 store
  src/ui               RN 原语、token 与页面
apps/agent             平台无关的 Agent 运行时（不依赖 Electron/React），由 desktop 的 utility process 拉起
  src/index.ts         公共入口：desktop worker 的唯一导入面
  src/composition.ts   跨客户端组装入口：CLI 等客户端按领域组装 Bot 与 Conversation Application
  src/host.ts           Conversation/Interview worker 组合根：路由命令、连接领域模块
  src/client           平台无关连接状态机：worker host 端口、退避重试与状态快照
  src/worker            worker 线协议类型（main ↔ agent 命令与帧）
  src/answer/host.ts    Answer-only worker 组合入口
  src/answer/application.ts  截图答题一次性用例与 transcript 生命周期
  src/core/agent        静态 Agent 注册、AI SDK 执行与 run 生命周期
  src/core/session      Session/Turn/Step journal、投影、恢复写回、SessionRuntime 门面、FIFO 调度与 step/turn 执行编排（当前为内存与端口级）
  src/core/bot          Bot 身份/发现契约、启动期不可变目录与会话参与者可见性
  src/core/team         团队预置与交接任务校验
  src/core/transcript   Conversation、Answer、Interview 共用的 transcript 端口、内存与 SQLite 适配器（baseline + _migrations 迁移）；answer 仅内存
  src/core/run         进程内 run 取消与完成等待原语
  src/core/model       provider 适配、模型流归一化、图片输入与 HTTP 重试
  src/core/skill       skill 来源扫描、frontmatter 校验、索引渲染与按名加载
  src/core/instruction 全局与项目 AGENTS.md 发现、读取与 system prompt 渲染
  src/execution        run/attempt/step 事件、状态、进程内 store 和投影
  src/conversation     对话领域：turn、agent、profiles、tools 子域
  src/interview        面试领域：intake 资料整理、profile 上下文、rehearsal 与 audio/transcription/turns/vad/reply
  scripts/db           开发期 DB 生成与校验；不进入运行时 bundle
examples/vad-asr-eval  独立 workspace 的可选 VAD/ASR 评测：按需安装，不进根 workspace、依赖安装或常规门禁
scripts/architecture   架构守护脚本（深导入/依赖环/平台越界检查）
scripts/docs           文档门禁
.agents/skills         AI 开发流程指南
docs/notes             按生命周期与类别管理的工程 Note
docs                   Note 索引
```

### 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm bootstrap` | 环境初始化：安装依赖并补齐 Electron 二进制 |
| `pnpm dev` | 以 answer Profile 启动 Vite + Electron（先构建 main/preload bundle） |
| `pnpm dev:full` | 以 full Profile 启动开发窗口（含聊天与面试） |
| `pnpm dev:cli` | 开发态直接运行 CLI 源码（tsx + 仓库根 `.env`；TTY 下进入 TUI） |
| `pnpm --filter @answra/desktop vad:prepare` | 下载并校验 TEN VAD 运行资源 |
| `pnpm --filter @answra/desktop asr:prepare` | 下载并校验本地 Paraformer ASR 模型 |
| `pnpm --filter @answra/cli build` | 构建 ESM CLI bundle（`apps/cli/dist/main.mjs`） |
| `pnpm --filter @answra/cli test` | CLI 配置、会话、TUI 组件、view store 与命令分派测试 |
| `pnpm --filter @answra/cli smoke:electron` | 构建后用 Electron 35.0.0 的 Node 22.14 跑 CLI 与本地假模型端点 smoke |
| `node apps/cli/dist/main.mjs code "..."` | 以系统 Node 22.13+ 运行 CLI；也可用 `ELECTRON_RUN_AS_NODE=1` 复用 Electron 35.0.0 的 Node |
| `pnpm --filter @answra/mobile start` | 启动 Expo 开发服务器；`android`/`ios` 脚本进入对应平台 |
| `pnpm --filter @answra/mobile typecheck` | 移动端 TypeScript 检查 |
| `pnpm --filter @answra/mobile test` | 移动端 core/transport 单元测试 |
| `pnpm --filter @answra/mobile exec expo-doctor` | 检查 Expo 配置、依赖版本与 Metro 配置 |
| `cd apps/mobile && eas build --platform android --profile preview` | EAS 云构建 Android APK；需先 `eas login` 与 `eas init` |
| `pnpm build` | 全 workspace 构建（desktop: esbuild + vite） |
| `pnpm typecheck` | 各包依次 `tsc --noEmit`（desktop 按进程分三个编译单元） |
| `pnpm test` | 各包测试（ui 使用 vitest + jsdom） |
| `pnpm db:check` | 校验 baseline、`_migrations`、生成物与 fresh DB 启动 |
| `pnpm db:generate` | 重建 migration registry 与 schema 快照 |
| `pnpm db:test` | 运行迁移 runner 的升级、幂等、checksum 与回滚测试 |
| `pnpm db:reset --yes` | 删除 CLI/桌面开发会话数据库并保留 legacy 归档 |
| `pnpm notes:hint` | Note 格式、本地链接和变更配对检查（仅提示，不阻断） |
| `pnpm notes:check` | 同 `notes:hint` 但严格：缺失或格式错误即失败（CI/发布用） |
| `pnpm architecture:check` | 架构守护检查 |
| `pnpm --dir examples/vad-asr-eval install` | 可选：单独安装 VAD/ASR 评测依赖，不影响根 workspace |
| `pnpm --dir examples/vad-asr-eval eval:eot` | 可选运行真实中文轮次 VAD/ASR 评测，结果在 `examples/vad-asr-eval/out/` |
| `pnpm verify` | lint + typecheck + `db:check` + test + architecture（Note 检查为提示；pre-push 同款） |

## 参与开发

- 包结构、依赖方向、IPC 约定见 [AGENTS.md](AGENTS.md)；改动须通过 `pnpm verify` 与架构守护脚本。
- 重要交互变化需补充或更新测试（`packages/ui/test/`）。
- 不要将凭据、本机数据或生成的安装包提交到 Git。
- 向本仓库提交更改或 PR，即表示你同意该贡献按 [LICENSE](LICENSE) 授权发布。

## 许可

本项目源码按 [PolyForm Noncommercial License 1.0.0](LICENSE) 授权：个人学习、研究、非商业机构等任何非商业用途免费使用；**任何商业用途都需要另行获得授权**（通过 [Issues](https://github.com/JarsirLiu/Answra/issues) 联系）。
