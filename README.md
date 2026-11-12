# 会议辅助工具

面向办公会议场景的本地优先桌面助手，使用 React、TypeScript 和 Electron 构建界面。

## 当前范围

- 三段式悬浮导航：模式选择、模式功能、笔记/资料/设置等全局入口。
- 按需展开的对话、笔记、参考资料和设置面板。
- 支持应用内区域截图、添加本地图片、填写补充问题并作为同一条消息发送。
- 对话回复为演示内容，尚未连接后端或 AI 模型。
- Windows 面试语音试用接入会议系统声音与候选人麦克风，经本地 VAD/ASR 后在面板按说话方显示识别文本和 VAD 端点；当前不生成回答。
- 隐身模式通过 Electron 窗口捕获保护请求系统排除应用表面；实际效果需按 Electron 和 Windows 版本验证。

工程决策、功能方案、缺陷复盘和架构边界统一记录在[工程 Note](docs/README.md)。

## 环境要求

- Node.js 22.13 或更新版本（pnpm 11.9 的最低要求）
- pnpm 11.9.0，建议通过 Corepack 管理
- Windows 可运行原生 Electron 桌面窗口；其他平台可通过 `pnpm dev:web` 预览 renderer

## 开发

```powershell
corepack enable
pnpm bootstrap
pnpm --filter @answra/desktop vad:prepare
pnpm --filter @answra/desktop asr:prepare
pnpm dev
```

`pnpm bootstrap` 是统一的环境初始化入口：安装 workspace 依赖，并校验/通过 npmmirror 镜像补齐 Electron 二进制，避免 `pnpm dev` 启动时才临时下载卡住。`pnpm dev` 默认按 answer Profile 启动，和公开发布安装包保持同一套功能裁切；需要聊天或面试时使用 `pnpm dev:full`。两者都会同时启动 Vite 和 Electron，`pnpm dev:web` / `pnpm dev:web:full` 可只启动浏览器预览。桌面开发窗口使用 5180 端口；端口被占用时命令会报错退出，不会静默换端口。

面试语音运行还需要 TEN VAD 与 Paraformer 模型。上面两条 prepare 命令会下载并校验资源；ASR 模型约 82 MB，支持断点续传。`bootstrap` 不包含这两类语音资源。

## 检查

```powershell
pnpm verify   # lint + typecheck + test + architecture:check（Note 检查仅提示，不阻断）
pnpm build
```

Windows 安装包通过 `pnpm dist:win` 构建，当前为未签名的 NSIS 安装包，不需要代码签名证书。

## 发版与分发

打包产物（安装包、blockmap 差量文件、`latest.yml` 清单）由 electron-builder 的 `publish` 配置指向腾讯云 COS 的 `download/latest/` 目录；桌面端 `electron-updater` 启动后按该清单静默检查更新、退出时自动安装，官网下载按钮也指向同一地址。

```powershell
# 1. 改 apps/desktop/package.json 的 version（electron-updater 按 semver 判断新版本）
# 2. 品牌图标变更时重新生成 build/ 下图标
pnpm --filter @answra/desktop icons
# 3. 打包并上传（密钥走环境变量，不入库）
$env:COS_SECRET_ID="..."; $env:COS_SECRET_KEY="..."
pnpm release:win
```

`release:win` = `dist:win` + `apps/desktop/scripts/upload-to-cos.mjs`（同时归档到 `download/v{版本}/` 便于回滚）；加 `--dry-run` 参数可只列出待上传产物。

macOS 安装包（dmg + zip，arm64/x64 各一份，未签名）只能在 macOS 上打包：

```powershell
# 本机（macOS）：构建并上传
pnpm release:mac
```

CI 侧使用 `.github/workflows/release.yml`（`Release`）：打 `v*` tag 或手动触发后，`windows-latest` 跑 `dist:win`、`macos-14` 跑 `dist:mac`，两个平台各自产出安装包作为 workflow artifact；随后唯一的 publish 作业把它们合并、校验 tag 与 `apps/desktop/package.json` 版本一致、上传到 COS 的 `download/latest/` 与 `download/v{版本}/`，tag 构建还会附到 GitHub Release。需要仓库 Secrets：`COS_SECRET_ID`、`COS_SECRET_KEY`。应用内更新两平台统一走「下载更新 → 进度条 → 安装/换装重启」（mac 未签名构建用自研换装脚本，替换方案与真机验收点见 `docs/notes/implemented/feature/2026-11-01-cross-platform-auto-update.md`）；未签名 mac 包首次启动需右键「打开」。

## 仓库结构

pnpm workspace monorepo：包间依赖只走 `workspace:*` 与各包 `exports` 声明的公开入口；IPC 频道与载荷类型集中在 `@answra/shared`；渲染层 UI 与平台能力（DesktopBridge）解耦，`packages/ui` 不允许直接接触 Electron。

```text
packages/shared        跨进程契约：IPC 频道常量 + ChannelMap 类型、环境变量常量、领域类型
  src/schema/events.ts Agent 全量事件目录与唯一 envelope；delta 不属于 durable 候选
  src/schema/status.ts Agent run/step 状态词汇与快照
  src/schema/connection.ts Agent 连接状态词汇与稳定失败码（桌面/CLI 共用）
packages/ui            悬浮条与面板的全部业务 UI（React），含组件测试
apps/desktop           Electron 桌面壳
  src/main             主进程：窗口管理、按领域拆分的 IPC handler
  src/main/connection  Agent 连接状态 IPC、窗口广播与 Electron worker host 适配
  src/preload          contextBridge 桥（window.answra）
  src/renderer         薄渲染层：仅挂载 <FloatingBarApp/>
apps/agent             平台无关的 Agent 运行时（不依赖 Electron/React），由 desktop 的 utility process 拉起
  src/index.ts         公共入口：desktop worker 的唯一导入面
  src/composition.ts   跨客户端组装入口：CLI 等客户端按领域组装 Bot 与 Conversation Application
  src/host.ts           Conversation/Interview worker 组合根：路由命令、连接领域模块
  src/client           平台无关连接状态机：worker host 端口、退避重试与状态快照
  src/worker            worker 线协议类型（main ↔ agent 命令与帧）
  src/answer/host.ts    Answer-only worker 组合入口
  src/answer/application.ts  截图答题一次性用例与 transcript 生命周期
  src/core/agent        静态 Agent 注册、AI SDK 执行与 run 生命周期
  src/core/bot          Bot 身份/发现契约、启动期不可变目录与会话参与者可见性
  src/core/team         团队预置与交接任务校验
  src/core/transcript   Conversation、Answer、Interview 共用的 transcript 端口与内存适配器
  src/core/run         进程内 run 取消与完成等待原语
  src/core/model       provider 适配、模型流归一化、图片输入与 HTTP 重试
  src/execution        run/attempt/step 事件、状态、进程内 store 和投影
  src/conversation     对话领域：turn、agent、profiles、tools 子域
  src/interview        面试语音领域：audio、transcription、turns、vad、reply 与 worker adapter
examples/vad-asr-eval  独立 workspace 的可选 VAD/ASR 评测：按需安装，不进根 workspace、依赖安装或常规门禁
scripts/architecture   架构守护脚本（深导入/依赖环/平台越界检查）
scripts/docs           文档门禁
.agents/skills         AI 开发流程指南
docs/notes             按生命周期与类别管理的工程 Note
docs                   Note 索引
```

常用命令：

| 命令 | 说明 |
| --- | --- |
| `pnpm bootstrap` | 环境初始化：安装依赖并补齐 Electron 二进制 |
| `pnpm dev` | 以 answer Profile 启动 Vite + Electron（先构建 main/preload bundle） |
| `pnpm dev:full` | 以 full Profile 启动开发窗口（含聊天与面试） |
| `pnpm --filter @answra/desktop vad:prepare` | 下载并校验 TEN VAD 运行资源 |
| `pnpm --filter @answra/desktop asr:prepare` | 下载并校验本地 Paraformer ASR 模型 |
| `pnpm build` | 全 workspace 构建（desktop: esbuild + vite） |
| `pnpm typecheck` | 各包依次 `tsc --noEmit`（desktop 按进程分三个编译单元） |
| `pnpm test` | 各包测试（ui 使用 vitest + jsdom） |
| `pnpm notes:hint` | Note 格式、本地链接和变更配对检查（仅提示，不阻断） |
| `pnpm notes:check` | 同 `notes:hint` 但严格：缺失或格式错误即失败（CI/发布用） |
| `pnpm architecture:check` | 架构守护检查 |
| `pnpm --dir examples/vad-asr-eval install` | 可选：单独安装 VAD/ASR 评测依赖，不影响根 workspace |
| `pnpm --dir examples/vad-asr-eval eval:eot` | 可选运行真实中文轮次 VAD/ASR 评测，结果在 `examples/vad-asr-eval/out/` |
| `pnpm verify` | lint + typecheck + test + architecture（Note 检查为提示；pre-push 同款） |

## 参与开发

- 包结构、依赖方向、IPC 约定见 [AGENTS.md](AGENTS.md)；改动须通过 `pnpm verify` 与架构守护脚本。
- 重要交互变化需补充或更新测试（`packages/ui/test/`）。
- 不要将凭据、本机数据或生成的安装包提交到 Git。
- 向本仓库提交更改或 PR，即表示你同意该贡献按 [LICENSE](LICENSE) 授权发布。

## 许可

本项目源码按 [PolyForm Noncommercial License 1.0.0](LICENSE) 授权：个人学习、研究、非商业机构等任何非商业用途免费使用；**任何商业用途都需要另行获得授权**（通过 [Issues](https://github.com/JarsirLiu/Answra/issues) 联系）。
