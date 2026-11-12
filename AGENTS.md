# 仓库协作规范（AGENTS.md）

面向人类协作者与 AI 助手的仓库结构与架构约定。目标是支持团队长期迭代，而非一次性原型。

## 包结构与依赖方向

```text
@answra/shared  ←  @answra/ui  ←  @answra/desktop(renderer)
                                    ↑
@answra/shared  ←  @answra/desktop(main / preload)
@answra/shared  ←  @answra/agent  ←  @answra/desktop(main)
                                  ←  @answra/cli
```

- 依赖必须单向，禁止环（`pnpm architecture:check` 强制）。
- 跨包导入只允许使用目标包 `package.json` `exports` 声明的入口；禁止深导入、禁止相对路径跨包（架构脚本强制）。
- 新增共享能力时：类型/常量进 `shared`，纯 UI 进 `ui`，平台能力进 `desktop`，与平台无关的 Agent 运行时进 `agent`。
- Agent 事件 payload 的唯一目录与 envelope 定义在 `packages/shared/src/schema/events.ts`；状态词汇/快照单独定义在 `status.ts`。`AgentDurableEvent` 仅规定未来适配器的事件资格，不代表已有持久化实现。
- `apps/` 只放可启动单元（`desktop` 是 Electron 壳，`agent` 由 utility process 拉起并保留独立为常驻 sidecar 的可能，`cli` 是独立终端宿主）；纯库放 `packages/`。

## 进程边界（apps/desktop）

| 目录 | 职责 | 约束 |
| --- | --- | --- |
| `src/main` | 窗口管理、生命周期、按领域拆分的 IPC handler（`src/main/ipc/*Ipc.ts`、`src/main/connection/*Ipc.ts`） | 可用 electron / node 内置模块 |
| `src/main/connection` | Agent worker 连接状态 IPC、窗口广播与 Electron worker host 适配 | 状态机与重试策略在 `@answra/agent`，不得在 desktop 复制连接语义 |
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
| `src/core/agent` | 静态 Agent 注册、模型路由、AI SDK 执行与统一事件写入 | 不读写 transcript、不包含领域 prompt/工具授权；领域注入注册后的 executor |
| `src/core/bot` | Bot 身份/发现契约、启动期不可变目录与会话参与者可见性校验 | 不持有 store、不创建 run、不 import 领域、不定义 prompt；独立助手与团队共用同一目录 |
| `src/core/team` | 团队预置与交接任务校验 | 只描述预置成员；不持有 Bot 身份、执行器或 profile |
| `src/core/transcript` | Conversation、Answer、Interview 共用的消息 transcript、活动 run 认领、恢复游标端口与内存适配器 | 不保存 Agent 事件、不包含领域产品策略；当前无磁盘持久化 |
| `src/core/model` | AI SDK/provider 边界归一化、共享模型输入校验与 HTTP 重试原语 | 不放 Conversation profile 或 transcript 规则 |
| `src/core/tool` | 跨领域工具契约、静态注册表与单次调用执行管理；通用工具在 `builtin/` | 不导入领域、不写工具事件；领域专属工具留在 `<domain>/tools/`，执行器只返回结果 |
| `src/execution` | run/attempt/step 状态迁移规则、事件 envelope 工厂、进程内 store 和查询投影 | 跨包事件 payload 与状态词汇唯一来自 `packages/shared/src/schema/`；当前只实现进程内 store，不得声称已有 durable store 或恢复流程 |
| `src/conversation/application.ts` | Conversation 唯一编排循环：按 Bot/团队选择创建会话、运行当前 Bot、执行交接链 | 只组合 catalog/store/run；不复制消息或 run 语义，不让 renderer 选择 Bot 之外的能力 |
| `src/conversation/turn` | Conversation transcript 回合认领、模型上下文与应用事件回调 | 模型执行/run 生命周期由 `core/agent` 负责；不定义共享执行状态 schema |
| `src/conversation/agent.ts`、`src/answer/agent.ts` | 各领域静态 Agent 定义，组装 prompt、上下文和授权工具 | 不接收 renderer 提供的任意 prompt 或工具实现 |
| `src/conversation/bots` | Conversation Bot 工厂：把身份、执行器与 profile 装配成目录项 | 新增 Bot 不改会话编排；不接收 renderer 注入 prompt、工具或发现关系 |
| `src/answer/application.ts` | 截图答题用例、一次性 transcript 清理和事件回调 | 不实现模型调用、重试或第二套事件 |
| `src/coding` | CLI coding 领域：独立 Bot、prompt/policy、transcript 上下文、单 Bot 会话用例与 host 装配 | 不 import `conversation`/`interview`；不启动 VAD/ASR；不做 team/handoff |
| `src/conversation/profiles` | Conversation 内部提示词、上下文策略与工具授权清单 | 只声明授权 `ToolId[]`，不接收 renderer 提供的任意 prompt 或工具实现 |
| `src/<domain>/tools` | 领域专属工具实现，实现 `core/tool` 契约 | 不执行桌面平台能力；不得由 desktop 反向 RPC 代执行 |
| `src/interview` | 语音采集后的转录、turn 与自动回复领域，包括 worker DTO adapter | 与 Conversation 保持平级，不把面试状态塞进会话目录；领域逻辑不放入 `worker/` |
| `src/interview/runtime.ts` | 面试媒体生命周期组合：连接 audio ingress、VAD、ASR、turn assembler/settler 与 InterviewApplication | 只编排领域端口，不定义 worker 协议或模型执行策略 |
| 平台能力与工具 | 采集、键鼠注入、窗口、密钥等桌面平台实现留在 desktop；Agent 工具由 Agent 注册并在 Agent 进程执行 | desktop 可注入工作区根目录等授权上下文，不得代执行 Agent 工具或通过反向 RPC 提供工具能力 |

入口规则：desktop 只从 `@answra/agent`（`exports` 的 `.`）导入；CLI 或其他客户端组装领域 Bot 时使用 `@answra/agent/composition`，不得深导入。本包不产出独立构建产物，由 desktop 的 `build:electron` 或 CLI 的 `build` 一并 bundle。

仓库根目录 `examples/vad-asr-eval/` 是独立的可选真实样本 VAD/ASR 评测 workspace：原句与链路转录并排供人工审阅，不生成回答；经 `@answra/agent/evaluation` 公开入口调用。它不在根 pnpm workspace 内，不参与根安装、`pnpm verify` 或 CI 测试；需在目录内单独 `pnpm install`，下载资产和 CSV 产物不入 Git。

## CLI 入口（apps/cli）

| 目录 | 职责 | 约束 |
| --- | --- | --- |
| `src/main.ts` | 可执行组合根：注入 process/env/stdin/stdout、SIGINT 与真实 Agent host | 只接线，不承载命令解析、会话状态机或呈现逻辑 |
| `src/cli` | 顶层命令分派、`code` 用例、依赖端口、help/error | 只依赖端口，不 import Electron 或 desktop |
| `src/config` | argv、环境变量、模型端点与工作区校验 | 不启动会话、不写事件 |
| `src/session` | `CodingSession` 单活动 run 用例与窄宿主端口 | 不实现模型调用、TUI 或进程 I/O |
| `src/adapters` | `@answra/agent/composition` 的 `CodingHost` 到 CLI 端口映射 | 不复制 Agent 运行时语义 |
| `src/presentation` | Agent 事件到非 TTY 文本、工具行格式化 | 纯投影，不读写会话或进程 |
| `src/transport` | stdin/stdout/stderr 适配 | 不定义业务行为 |

- CLI 只从 `@answra/agent/composition` 组装 coding host，不使用 worker 线协议、不启动 VAD/ASR、不 import `conversation`/`interview` 领域。
- CLI 运行时下限是 Node 20.9，构建 target 固定 `node20.9`；仓库开发、CI 与 pnpm 仍要求 Node >=22.13，两者不是同一个运行时。
- 安装包分发可复用 Electron 29.4.6 的 Node 20.9（`ELECTRON_RUN_AS_NODE=1`）运行 CLI bundle，不新增 Node sidecar、不启动 GUI；不得为 CLI 升级 Electron 而绕过隐身验收。
- 安装包通过 electron-builder `extraResources` 分发 `resources/cli/main.cjs`，Windows 的 `answra.cmd` 只复用同目录 `Answra.exe`；不新增 CLI 可执行文件，shim 不自动注册 PATH。
- `apps/desktop` 的 Electron 29.4.6 是当前唯一通过捕获保护实测的基线；共享 `agent`/`shared` 代码必须保持 Node 20.9 兼容，desktop worker bundle 继续以 `node20.9` 为目标。

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

- `pnpm verify` = biome lint + 全包 typecheck + vitest + 架构守护 + `tokens:check`；其中 Note 检查走 `pnpm notes:hint`（只提示、不阻断本地提交）；husky pre-push 自动执行。
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
