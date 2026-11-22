# 仓库协作规范（AGENTS.md）

面向人类协作者与 AI 助手的仓库结构与架构约定。目标是支持团队长期迭代，而非一次性原型。

## 包结构与依赖方向

```text
@answra/shared  ←  @answra/ui  ←  @answra/desktop(renderer)
                                    ↑
@answra/shared  ←  @answra/desktop(main / preload)
@answra/shared  ←  @answra/agent  ←  @answra/desktop(main)
                                  ←  @answra/cli
@answra/shared  ←  @answra/config  ←  @answra/desktop(main)
                                   ←  @answra/cli
@answra/credentials  ←  @answra/desktop(main)
                     ←  @answra/cli
@answra/shared  ←  @answra/remote  ←  @answra/remote-node  ←  @answra/cli
                                                          ←  @answra/desktop(main)
@answra/shared  ←  @answra/remote  ←  @answra/mobile
@answra/shared  ←  @answra/mobile
```

- 依赖必须单向，禁止环（`pnpm architecture:check` 强制）。
- 跨包导入只允许使用目标包 `package.json` `exports` 声明的入口；禁止深导入、禁止相对路径跨包（架构脚本强制）。
- 新增共享能力时：类型/常量进 `shared`，纯 UI 进 `ui`，平台能力进 `desktop`，与平台无关的 Agent 运行时进 `agent`；跨桌面/CLI 的非 secret 客户端配置进 `config`，共享本地模型 API Key 进 `credentials`。
- `@answra/config` 是 Node-only 客户端配置库：只存本地模型地址/模型 ID 等非 secret 字段；API Key 由 `@answra/credentials` 写入 OS keychain，登录令牌仍由桌面 `safeStorage` 负责，CLI 不得解密桌面 `safeStorage` 文件。
- `@answra/credentials` 是 Node-only OS 凭据库：只封装本地模型 API Key 的 keychain 读写，不读写 `config.json`、不依赖 Electron/CLI/Agent；keychain 不可用时 fail-closed，不回退明文。桌面 main 与 CLI 共用固定 service/account。
- `@answra/remote` 是平台无关的远程连接核心：只放远程帧编解码、host/controller 端口、配对/信令状态机与 fake ports；只能依赖 `@answra/shared`，不得 import Electron/Node/React/Ink/Agent/CLI/desktop。WebRTC、WebSocket、OS keychain 由各宿主适配。
- `@answra/remote-node` 是 Node-only 远程适配库：只封装信令 HTTP/WebSocket、计时器、`node-datachannel` WebRTC 与 `startRemoteHost` 组合；只能依赖 `@answra/remote`、`@answra/shared` 与 Node 内置模块，不得 import Electron/React/Ink/Agent/CLI/desktop。CLI 与桌面 main 共用，controller 侧不得依赖该包。
- `apps/mobile` 是 Android-first Expo/RN 移动端 controller：只依赖 `@answra/shared` 与 `@answra/remote`；不得 import `@answra/agent`、`@answra/remote-node`、`@answra/config`、`@answra/credentials`、`@answra/ui`、desktop 或 CLI。WebRTC/WebSocket/SecureStore 只在 `src/transport`、`src/auth`、`src/credentials` 适配。
- `@answra/skills` 是纯内容包：只放内置 skill 的 Markdown 与资源，不含运行时代码；宿主解析目录后注入 agent，agent 不 import 该包。
- Agent 事件 payload 的唯一目录与 envelope 定义在 `packages/shared/src/schema/events.ts`；状态词汇/快照单独定义在 `status.ts`。`AgentDurableEvent` 仅规定未来适配器的事件资格，不代表已有持久化实现。
- `apps/` 只放可启动单元（`desktop` 是 Electron 壳，`agent` 由 utility process 拉起并保留独立为常驻 sidecar 的可能，`cli` 是独立终端宿主）；纯库放 `packages/`。

## 进程边界（apps/desktop）

| 目录 | 职责 | 约束 |
| --- | --- | --- |
| `src/main` | 窗口管理、生命周期、按领域拆分的 IPC handler（`src/main/ipc/*Ipc.ts`、`src/main/connection/*Ipc.ts`、`src/main/conversation/sessionIpc.ts`） | 可用 electron / node 内置模块 |
| `src/main/connection` | Agent worker 连接状态 IPC、窗口广播与 Electron worker host 适配 | 状态机与重试策略在 `@answra/agent`，不得在 desktop 复制连接语义 |
| `src/main/remote` | 桌面远程 host 生命周期、加密 host key、Agent 命令端口与远程 IPC | 信令/WebRTC/重试在 `@answra/remote` 与 `@answra/remote-node`，不得复制协议；host key 只走 `safeStorage` |
| `src/preload` | `contextBridge` 暴露唯一 `window.answra` API 面 | 只做转发，不放业务逻辑 |
| `src/renderer` | 薄壳：挂载 `<FloatingBarApp/>` | 禁止 import electron / node 模块 |

## Agent 运行时（apps/agent）

| 目录 | 职责 | 约束 |
| --- | --- | --- |
| `src/host.ts` | Conversation/Interview worker 组合根：创建运行时、路由显式命令、连接面试领域 adapter | 只接线，不承载 VAD/ASR/turn 算法；Answer-only 入口位于 `src/answer/host.ts` |
| `src/composition.ts` | 跨客户端组装入口：暴露 runtime、store、工具注册表、Bot 契约/目录/工厂与 Conversation Application | 不包含 worker 线协议、Electron 或 CLI 传输层；CLI 与其他客户端从这里按领域组装 Bot |
| `src/client` | 平台无关连接客户端：worker host 端口、连接状态机、退避重试与状态快照 | 不依赖 Electron；不写 transcript 或 `AgentEventEnvelope`；desktop/CLI 只做 host 与传输适配 |
| `src/worker` | 线协议 `AgentCommand` / `AgentFrame`，跨进程唯一契约 | 只放协议类型；命令/帧变更必须同步 desktop worker |
| `src/core/run` | 跨领域进程内 run 取消与完成等待原语 | 不保存持久化 run 状态；不放产品策略 |
| `src/core/agent` | 静态 Agent 注册、模型路由、AI SDK 执行、统一当前时间上下文与事件写入 | 不读写 transcript、不包含领域 prompt/工具授权；领域注入注册后的 executor |
| `src/core/session` | Session/Turn/Step journal 与投影、恢复写回、SessionRuntime 门面、共享恢复协调器（`recoveryCoordinator`）、UI 兼容投影（`sessionEventProjector`）、journal 写入顺序（`sessionRuntimeJournal`）、FIFO 调度与 step/turn 执行编排 | 不写领域 prompt/工具或 transcript；Scheduler 只写 `turn-*`，StepExecutor 只写 `step-*`/usage，TurnExecutor 只写 `turn-handoff`，Compactor 经 `SessionRuntimeJournal.appendCompaction` 只写 `compaction-*`；SessionRuntime 不复制 turn/queue 状态；恢复只由会话所属领域触发，顺序固定为事实收口 → transcript 写回 → queued 续跑，跨领域恢复或提前续跑都会写坏 Turn |
| `src/core/bot` | Bot 身份/发现契约、启动期不可变目录与会话参与者可见性校验 | 不持有 store、不创建 run、不 import 领域、不定义 prompt；独立助手与团队共用同一目录 |
| `src/core/team` | 团队预置与交接任务校验 | 只描述预置成员；不持有 Bot 身份、执行器或 profile |
| `src/core/transcript` | Conversation、Answer、Interview 共用的消息 transcript、活动 run 认领、恢复游标端口、内存与 SQLite（`node:sqlite`）适配器；SQLite 使用 `schema.ts` baseline、`_migrations` 账本与 append-only migration | 不保存 Agent 事件、不包含领域产品策略；SQLite 适配器按 scope 写入 `sessions.sqlite` 并迁移旧 JSON，`answer` 只走内存、不读盘不落盘；不得用全局 `SCHEMA_VERSION` 或删库处理版本升级 |
| `src/core/model` | AI SDK/provider 边界归一化、共享模型输入校验与 HTTP 重试原语 | 不放 Conversation profile 或 transcript 规则 |
| `src/core/tool` | 跨领域工具契约、静态注册表与单次调用执行管理；通用工具在 `builtin/` | 不导入领域、不写工具事件；领域专属工具留在 `<domain>/tools/`，执行器只返回结果 |
| `src/core/skill` | 三类来源的 skill 扫描、frontmatter 校验、索引渲染与按名查表契约 | 不读领域 prompt、不接受模型传入路径；宿主注入根目录，缺省即没有 skill |
| `src/core/instruction` | 全局与项目 `AGENTS.md` 的发现、逐层读取、去重和 system prompt 渲染 | 不 import 领域或配置包、不猜测配置目录、不写 transcript；宿主注入全局文件路径，发现边界止于项目根 |
| `src/execution` | run/attempt/step 状态迁移规则、事件 envelope 工厂、进程内 store 和查询投影 | 跨包事件 payload 与状态词汇唯一来自 `packages/shared/src/schema/`；当前只实现进程内 store，不得声称已有 durable store 或恢复流程 |
| `src/conversation/application.ts` | Conversation 唯一编排循环：按 Bot/团队选择创建会话、运行当前 Bot、执行交接链 | 只组合 catalog/store/run；不复制消息或 run 语义，不让 renderer 选择 Bot 之外的能力 |
| `src/conversation/turn` | Conversation transcript 回合认领、模型上下文与应用事件回调 | 模型执行/run 生命周期由 `core/agent` 负责；不定义共享执行状态 schema |
| `src/conversation/agent.ts`、`src/answer/agent.ts` | 各领域静态 Agent 定义，组装 prompt、上下文和授权工具 | 不接收 renderer 提供的任意 prompt 或工具实现 |
| `src/conversation/bots` | Conversation Bot 工厂：把身份、执行器与 profile 装配成目录项 | 新增 Bot 不改会话编排；不接收 renderer 注入 prompt、工具或发现关系 |
| `src/answer/application.ts` | 截图答题用例、一次性 transcript 清理和事件回调 | 不实现模型调用、重试或第二套事件；答题会话只在内存，不持久化 |
| `src/coding` | CLI coding 领域：独立 Bot、prompt/policy、transcript 上下文、`StepStart` 绑定与单 Bot 会话用例；Turn/Step 状态与恢复由 `core/session` 持有 | 不 import `conversation`/`interview`；不启动 VAD/ASR；不做 team/handoff；排队按 Turn 原子启动，不在 tool step 间插入下一条消息 |
| `src/conversation/profiles` | Conversation 内部提示词、上下文策略与工具授权清单 | 只声明授权 `ToolId[]`，不接收 renderer 提供的任意 prompt 或工具实现 |
| `src/<domain>/tools` | 领域专属工具实现，实现 `core/tool` 契约 | 不执行桌面平台能力；不得由 desktop 反向 RPC 代执行 |
| `src/interview` | 语音采集后的转录、turn 与自动回复领域，包括 worker DTO adapter | 与 Conversation 保持平级，不把面试状态塞进会话目录；领域逻辑不放入 `worker/` |
| `src/interview/runtime.ts` | 面试媒体生命周期组合：连接 audio ingress、VAD、ASR、turn assembler/settler 与演练 InterviewApplication | 只编排领域端口，不定义 worker 协议或模型执行策略 |
| `src/interview/application.ts` | 面试文本会话用例：user 消息落账、assistant run 认领、snapshot/事件与无 user 消息开场占位 | 不定义 Agent prompt/工具；不启动音频 |
| `src/interview/intake` | 资料整理 Agent：读取简历/项目并维护 `profile.xml`；开场指令只进入模型请求 | 不接收 renderer 任意 prompt/工具；不启动音频；不与演练 transcript 混用 |
| `src/interview/profileContext.ts` | 画像路径、XML 格式与引导种子的只读上下文 | 不做文件读写；写入规则只注入 intake |
| 平台能力与工具 | 采集、键鼠注入、窗口、密钥等桌面平台实现留在 desktop；Agent 工具由 Agent 注册并在 Agent 进程执行 | desktop 可注入工作区根目录等授权上下文，不得代执行 Agent 工具或通过反向 RPC 提供工具能力 |

入口规则：desktop 只从 `@answra/agent`（`exports` 的 `.`）导入；CLI 或其他客户端组装领域 Bot 时使用 `@answra/agent/composition`，不得深导入。本包不产出独立构建产物，由 desktop 的 `build:electron` 或 CLI 的 `build` 一并 bundle。

仓库根目录 `examples/vad-asr-eval/` 是独立的可选真实样本 VAD/ASR 评测 workspace：原句与链路转录并排供人工审阅，不生成回答；经 `@answra/agent/evaluation` 公开入口调用。它不在根 pnpm workspace 内，不参与根安装、`pnpm verify` 或 CI 测试；需在目录内单独 `pnpm install`，下载资产和 CSV 产物不入 Git。

## CLI 入口（apps/cli）

| 目录 | 职责 | 约束 |
| --- | --- | --- |
| `src/main.ts` | 可执行组合根：注入 process/env/stdin/stdout、SIGINT 与真实 Agent host | 只接线，不承载命令解析、会话状态机或呈现逻辑 |
| `src/cli` | 顶层命令分派、`code`/`config`/`remote` 用例、依赖端口、help/error | 只依赖端口，不 import Electron 或 desktop |
| `src/config` | argv 语法、工作区校验与宿主 skill 根目录解析 | 不读写配置、不启动会话、不写事件 |
| `src/model` | CLI 模型设置域：选择、优先级、应用服务、持久化端口与模型目录端口 | 不 import `tui`/`cli`/`adapters`，不碰 `node:fs`、Ink 或终端输出 |
| `src/session` | `CodingSession` 单活动 run 用例、新建/恢复/列表/删除与窄宿主端口 | 不实现模型调用、TUI 或进程 I/O |
| `src/adapters` | `@answra/config` 共享文件实现、OpenAI 兼容 `/models` 模型目录、`@answra/agent/composition` 的 `CodingHost` 到 CLI 端口映射 | 不复制 Agent 运行时语义，不承载模型合并规则 |
| `src/remote` | CLI 远程 host 适配与 host key 存储 | 信令/WebRTC 只调用 `@answra/remote-node`；不保留 controller 入口；key 不进共享 config；TUI 不 import |
| `src/presentation` | Agent 事件到非 TTY 文本、工具行与模型摘要格式化 | 纯投影，不读写会话或进程 |
| `src/tui` | TUI 组合根：`runTui.tsx` 只做启动、登录/设置、命令与面板接线及渲染；备用屏幕用 Ink 原生 `alternateScreen` | 不 import Electron/desktop 或 `@answra/config`；`runTui.tsx` 不承载 Agent 命令分派、命令可用性规则或每会话 queue，也不保存运行状态 |
| `src/tui/runController.ts` | 每会话运行控制器：`CodingSession` 注册、切换/新建/删除与活动会话投影 | 不 import Ink/React/Node 进程；不创建第二套事件或 run 状态；后台完成只更新快照，不覆盖活动 phase |
| `src/tui/sessionRunQueue.ts` | 单会话提交到 host 队列、取消代际、busy 与排队投影 | 不 import Ink/React/Node 进程；不复制 Agent 队列位置或模型/transcript 语义 |
| `src/tui/panelHandlers.ts` | 面板动作到控制器与模型配置端口的接线 | 不判断 busy、不持有运行状态、不 import Ink |
| `src/tui/app` | 根布局与 view store：snapshot/事件 -> TuiState；按活动 `conversationId` 过滤 | store 是唯一 writer；不解析工具输出；切换会话重置 revision |
| `src/tui/transcript` | 虚拟 transcript、消息行、Markdown、选区文本与高度估算 | 只处理消息顺序、虚拟化与滚动；工具语义只走 `transcript/tool/` |
| `src/tui/transcript/tool` | 工具展示适配：`ToolCall`、详情、连续 read/search/list 折叠组 | 只消费 `@answra/ui/tool-presentation`；不重新解析工具输出或判断 Agent 事件 |
| `src/tui/composer` | 输入框、搜索框、宽字符/光标布局、历史与粘贴 | 不读写 transcript 或工具状态 |
| `src/tui/chrome` | 状态行、Spinner、主题与面板外框 | 不持有会话或工具状态 |
| `src/tui/commands` | slash 命令元数据、解析、`access` 策略、唯一分派边界与帮助/候选/参数提示 | 不承载 Agent 命令或 runtime；`dispatch.ts` 之外不写命令可用性规则 |
| `src/tui/commands/handlers` | 按命令族执行：session/model/account/remote/meta | 不判断 busy、不写第二套拒绝文案、不 import Ink |
| `src/tui/panels` | 面板 UI 与本地交互：config/model/sessions/status/help | 不判断 busy、不调用 session 或 `runTui` |
| `src/tui/notices` | 通知队列纯状态机与唯一通知渲染 | 队列不依赖 Ink/React/timer；渲染不持有队列或创建 timer |
| `src/tui/interaction` | 终端交互原语：指针解析、选区 store/action 与剪贴板输出 | 不 import `transcript`/`composer`/`runTui`；不解析 Ink 组件；指针/选区状态只由 store 写 |
| `src/transport` | stdin/stdout/stderr 适配 | 不定义业务行为 |

- CLI 只从 `@answra/agent/composition` 组装 coding host，不使用 worker 线协议、不启动 VAD/ASR、不 import `conversation`/`interview` 领域。
- CLI 模型配置只从 `@answra/config` 读取文件实现与纯合并函数；`src/model` 不碰文件路径，真实读写由 `main.ts` 注入 `src/adapters/sharedModelStore.ts`。模型列表只经 `ModelCatalog` 端口与 `src/adapters/openAiModelCatalog.ts` 访问当前端点。API Key 只走环境变量/参数或 `@answra/credentials` 的 OS keychain（TUI 的 `/config` 从 keychain 回填、默认掩码、`Ctrl+R` 显示/隐藏；未修改时不重写），不进入共享文件；keychain 不可用时 fail-closed。
- CLI 远程只保留 host：`answra remote host` 等待 PC/手机 controller；host 记录只存 secret 哈希，不进入共享模型配置。CLI 不保留 controller attach 与 controller 密钥文件。
- CLI 会话历史由 `main.ts` 注入 `SqliteConversationStore(resolveDefaultConfigDir()/cli/sessions)`；数据库为根目录下 `sessions.sqlite`，旧 JSON 首次启动导入 `legacy/`；列表按 `(updated_at, conversation_id)` keyset 游标分页（默认 50、上限 200），`/sessions` 按页追加；`src/session` 只切会话，`/new`、`/sessions`、`/resume`、`/delete` 走 `CodingSession` 与 catalog，host 由 `runInteractive` 统一 dispose。
- CLI 运行时目标为 Node >=22.13，构建 target 为 `node22.14`，与仓库开发、CI 与 pnpm 下限一致。
- 安装包分发复用 Electron 35.0.0 的 Node 22.14（`ELECTRON_RUN_AS_NODE=1`）运行 CLI bundle，不新增 Node sidecar、不启动 GUI。
- CLI 使用 ESM（`dist/main.mjs`）：Ink 8 与 yoga-layout 含 top-level await，不能打成 CJS；安装包通过 electron-builder `extraResources` 分发 `resources/cli/main.mjs`，Windows 的 `answra.cmd` 只复用同目录 `Answra.exe`；不新增 CLI 可执行文件，shim 不自动注册 PATH。
- `apps/desktop` 锁定 Electron 35.0.0（Node 22.14），捕获保护已在 Windows 11 实测通过；升级前按 `docs/notes/implemented/bug-fix/2026-10-11-electron-capture-protection-compatibility.md` 重跑系统截图/录屏验收。desktop worker 与 CLI bundle target 统一为 `node22.14`。

## 移动端入口（apps/mobile）

| 目录 | 职责 | 约束 |
| --- | --- | --- |
| `src/app` | Expo Router 路由与页面装配 | 只做路由和 UI 接线；不实现连接、认证或协议 |
| `src/core` | 平台无关连接用例、端口、host 元数据与会话投影 | 禁止 import React/RN/Expo/Node；不创建 WebSocket/PeerConnection |
| `src/transport` | RN WebSocket、`react-native-webrtc`、NetInfo、AppState 与计时器适配 | 只实现端口；不复制 `RemoteControllerSession`/重连策略 |
| `src/auth` | OAuth PKCE、深链回调与 token 刷新 | 不读写 host key；不把 token 放进日志或 URL |
| `src/credentials` | `expo-secure-store` 的 auth token 与 host key 适配 | 只读写 SecureStore；AsyncStorage 只放非 secret 元数据 |
| `src/state` | 移动视图状态与选择器 | 不复制连接状态、run 状态或 transcript |
| `src/ui` | RN 原语、token 与页面 | 不 import `@answra/remote`，不创建 peer 或命令 |

- 移动端只复用 `@answra/remote` 的 controller 会话/重连/命令语义；不新增第二套退避、错误码或草稿状态。
- 移动端原生构建走 EAS 云构建；不提交生成的 `android/`/`ios/`，签名凭据由 EAS 远程管理，不入库。
- 不配置 TURN/relay、不做桌面本地 H5 服务、不做手机本地 Agent；P2P 失败显式 `remote-unreachable`。
- Android 首版只做前台文本会话；iOS 复用同一 Expo/RN 工程；鸿蒙不承诺原生，后续 H5/ArkWeb 另评。
- Phase 0 只落骨架、端口、fake 与占位页面；真实 auth、WebRTC、SecureStore 和会话 UI 按移动端 Note 分阶段接入。

## IPC 约定（三层类型安全）

1. 频道常量与请求/响应类型映射只写在 `packages/shared/src/channels/` 对应领域文件；`packages/shared/src/channels.ts` 仅作为稳定聚合入口，命名 `answra:<域>:<动作>`。
2. main 侧 handler 按领域一个文件，注册前用 `isWindowFromSender` 校验来源。
3. preload 消费 ChannelMap 类型；renderer 通过 `DesktopBridge` 接口访问，测试注入 mock bridge。

## 环境变量

- 变量名只允许在 `packages/shared/src/env.ts` 定义一次；`.env.example` 逐项注明用途与是否 secret。
- 运行时读取统一走类型化函数（如 `parseAnswraEnv`），禁止散落 `process.env.XXX`。
- CLI 复用 `ANSWRA_AI_BASE_URL`，并使用 `ANSWRA_MODEL`、`ANSWRA_API_KEY`；不得读取桌面 `safeStorage` 或云端 OAuth 凭据。

## UI 原语与比例

- 动作按钮只用 `SurfaceButton`（文字）或 `IconButton`（纯图标，`label` 必填）；菜单项、列表行、Tab 用各自的 row/tab 样式，不复制按钮原语。
- 控件尺寸成对取 `--control-*` 的 `xs/sm/md/lg` 档，间距取 `--space-*`，字号取 `--font-*`；控件与悬浮条 CSS 禁止 `font-size/height/min-height/padding/gap` 的 px 字面量。
- 图标默认 `--icon`，文字默认 `--ink`；`--mint` 只做面（主操作实底、进度、开关、滑杆、选中填充），不得用作图标、文字或描边前景色。
- 每个面板/浮窗最多一个 `primary`；需要多个高优先级动作时降为 `default` 或 `quiet`。
- 新控件先补原语、测试（`packages/ui/test/controlsContract.test.tsx`）和 Note，再写业务组件；契约来源见 `docs/notes/proposed/architecture/2026-11-11-ui-primitive-and-proportion-contract.md`。

## 质量门禁

- `pnpm verify` = biome lint + 全包 typecheck + `db:check` + vitest + 发布 Profile 规范化检查（`profiles:check`）+ 架构守护 + `tokens:check`；其中 Note 检查走 `pnpm notes:hint`（只提示、不阻断本地提交）；husky pre-push 自动执行。
- `pnpm notes:check`（严格）保留给 CI 与发布前：缺少配套 Note、Note 格式不完整或本地链接失效时失败。CI（`.github/workflows/ci.yml`）以 `--base` 比较目标分支执行严格模式。
- 提交前自检与门禁执行要点（范围意图、Note 配对、全量门禁、diff 自审、秘密与工件、Conventional Commits）收编在 `.agents/skills/answra-code/SKILL.md` 终篇，不再单设 skill。
- 写代码与评审的工程规范见 `.agents/skills/answra-code/SKILL.md`：前置条件闸门（事实不足必须停下并客观告知）、代码落层判断、契约与类型纪律、状态与行为的显式来源（禁推演状态）、防御性代码预算、魔法值清零、规模预算（函数/文件/目录）、co-location、可读性、并行模块纪律。
- 每个 UI 行为变化在 `packages/ui/test/` 补测试；main 进程逻辑后续用 node:test/vitest 覆盖。
- 提交信息使用 Conventional Commits，标题简明。

## 文档

- `docs/notes/` 是方案、功能决策、缺陷复盘、架构约束和流程经验的唯一长期存放处；`docs/` 根目录不新增平铺专题文档。
- 功能新增/删除、用户行为变化、有复盘价值的缺陷、跨模块契约、架构/依赖/持久化/测试策略/工具流程变化，必须在同一变更中新增或更新 Note。纯格式、typo 和纯机械重命名可豁免。
- 每项独立功能或决策分别留痕。Note 必须写问题、影响范围、决定、真实替代方案及舍弃理由、后果，以及验证证据或防止重复踩坑的约束。
- Note 按 `proposed`、`implemented`、`rejected`、`archived` 生命周期和功能类别归档；格式与转换规则见 `docs/README.md` 和模板。
- AI 开发流程见 `.agents/skills/answra-change/SKILL.md`。本地 `pnpm verify` 只提示缺少配套 Note（`pnpm notes:hint`），不阻断提交；严格失败判定（缺少 Note、格式不完整、本地链接失效）由 `pnpm notes:check` 与 CI 执行。
- 产品方向与 Agent 底座规划见 `.agents/skills/answra-vision/SKILL.md`（正文提案在 `docs/notes/proposed/architecture/2026-10-20-product-direction-and-agent-foundation.md`）。新增能力域、新功能规划或跨域能力（工具、打断、存储、媒体流）设计前先核对。
- 结构性变更同时同步本文件、Note 和 README 仓库结构表。
