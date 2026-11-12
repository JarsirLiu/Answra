# Note：CLI Coding 模式与终端 UI（TUI）移植

状态：提案

## 问题

产品目前只有 Electron 桌面壳一种宿主。Agent 运行时本身已经平台无关，编码所需的 `Read`、`Grep`、`Edit`、`RunCommand`、`WriteStdin` 也已经在工具层落地，但用户只能在悬浮条里使用它们。用户要求增加一个 CLI 专用的 coding 模式，并希望终端 UI 尽量复刻 Claude Code。

需要先纠正上一版提案的事实错误：当前 `conversation` 域只有 `conversation.general` 一个 Bot（profile 为 `general-chat`），不存在 `conversation.coding`。桌面对话 Bot 是给悬浮条通用对话用的，没有按编码任务打磨；CLI 不能借用它，也不能把 CLI 的编码策略塞进 `conversation` 域。CLI 需要自己的 coding Bot、自己的策略和自己的会话用例。

现有事实构成了几个直接约束：

- `startAgentHost` 强制要求 `vad` 和 `recognizer`（`apps/agent/src/host.ts:45-50`），没有 conversation-only 入口；coding 场景不需要 VAD/ASR，不能把面试媒体管线带进来。
- `conversation` 域的 `ConversationApplication` 绑定 Bot 目录、team preset 和 handoff；CLI v1 不需要这些语义，直接复用会把桌面多 Bot 编排拖进来。
- `createBuiltinToolRegistry`、Bot 工厂和 profile 没有从 `@answra/agent` 公开导出，CLI 无法自行组合会话。
- 模型端点与凭据在 desktop main 的 `modelRouter.ts` / `modelSettings.ts` 中，依赖 Electron `safeStorage` 和云端 OAuth；CLI 没有独立来源。
- 架构守护只允许 `apps/agent/src` 和 desktop main/preload 使用 `node:` 内置模块，新 CLI/TUI 会被判越界。
- Claude Code 的 TUI 基于 Ink 和自研 fork；`src/components` 是 React Compiler 产物，并深度耦合 `AppState`、analytics、keybindings 和 `bun:bundle`，不能直接粘贴。

本提案先冻结 v1 范围：**一个独立的 coding 领域与 Bot、无 VAD、无审批、TUI 行为 1:1**。多 Bot、team 与自动交接明确后置。

## 涉及范围

- 代码/模块：
  - `apps/cli/`（新增）：Node 入口、coding host 装配、模型配置、TUI 业务组件与非 TTY 降级。
  - `packages/tui/`（新增）：Claude Code Ink fork 的终端渲染引擎移植，不含业务。
  - `apps/agent/src/coding/`（新增）：CLI 专属 coding 领域。
    - `agent.ts`：`CODING_AGENT_ID`、独立身份、发现与 `AgentDefinition`。
    - `policy.ts`：coding 专用 system prompt、工具授权与上下文策略。
    - `bot.ts`：`CodingBot` 描述符（`BotDescriptor<CodingAgentInput, CodingPolicy>`，`domain: "coding"`）。
    - `application.ts`：单 Bot 会话用例，只处理 user-triggered run，不引入 team/handoff。
    - `host.ts`：`startCodingHost`，装配 runtime、工具、store 与事件回调。
  - `apps/agent/src/coding/context.ts`：coding 专用模型上下文，直接复用 `core/transcript/projection`；只读取 transcript，不 import `conversation/turn`。
  - `apps/agent/src/core/bot/contracts.ts`：`BotDomain` 增加 `"coding"`。
  - `apps/agent/src/composition.ts`：公开 `startCodingHost` 与 `CodingApplication` 的最小类型。
  - `apps/agent/src/conversation/`：不修改；桌面对话的 prompt、profile 和上下文构建保持原样。
  - `packages/ui/package.json`、`packages/ui/src/app/conversationView.ts`、`packages/ui/src/app/conversationParts.ts`：增加 `./conversation-view` 纯投影子入口。
  - `scripts/architecture/architecture-check.mjs`：把 `apps/cli/src`、`packages/tui/src` 加入 node 内置模块白名单。
  - `apps/desktop/scripts/cli-packaging.mjs`、`apps/desktop/resources/cli/answra.cmd`、`apps/desktop/scripts/audit-packaged-app.cjs`、`apps/desktop/package.json`：安装包分发 CLI bundle、Windows shim 与打包审计。
  - `AGENTS.md`、`README.md`：同步包结构、依赖方向、领域表与仓库结构表。
- UI/进程/协议/持久化表面：
  - 进程：开发/系统 Node 模式为独立 Node 进程；安装包分发复用 Electron 29.4.6 内置 Node 20.9（`ELECTRON_RUN_AS_NODE=1`），不启动 GUI/Chromium，不新增 Node sidecar，不新增本地监听。
  - 协议：不复用 `AgentCommand` / `AgentFrame`。CLI 在进程内直接调用 `CodingApplication`；未来若 attach 桌面，再走 `AgentTransport`。
  - 持久化：v1 沿用内存 store，退出即丢；不承诺恢复。
  - UI：终端 UI 与 DOM UI 分离；只共享纯投影逻辑，不共享组件。
- 相关 Note：
  - [产品方向与 Agent 底座](2026-10-20-product-direction-and-agent-foundation.md)
  - [领域 Agent 模块注册与面试链路归属](2026-11-07-domain-agent-module-registration.md)
  - [Bot 目录与会话参与者选择](2026-11-12-bot-catalog-and-conversation-selection.md)
  - [多 Bot 同会话注册、发现与交接](2026-11-11-multi-bot-session-registry-and-handoff.md)
  - [Agent host 组装与传输](../../implemented/architecture/2026-10-17-agent-host-composition-and-transport.md)
  - [统一 Conversation UI 投影](../../implemented/architecture/2026-11-06-unified-conversation-view-projection.md)
  - [单一 Agent 事件流](../../implemented/architecture/2026-11-07-single-agent-event-stream.md)
  - [域应用边界](../../implemented/architecture/2026-11-08-domain-applications.md)
  - [Answer application 边界](../../implemented/architecture/2026-11-08-answer-application-boundary.md)
  - [core transcript store](../../implemented/architecture/2026-11-08-core-transcript-store.md)
  - [Agent 工具系统基础](../../implemented/architecture/2026-11-09-agent-tool-system-foundation.md)
  - [Shell 工具与会话运行时](../../implemented/feature/2026-11-09-shell-tools-and-session-runtime.md)
  - [工作区 Edit 工具](../../implemented/feature/2026-11-10-workspace-edit-tool.md)
  - [Edit 多 hunk diff 展示](../../implemented/architecture/2026-11-10-edit-multi-hunk-diff-display.md)
  - [Agent 连接域](../../implemented/architecture/2026-11-10-agent-connection-domain.md)
  - [拒绝将 Pi 作为桌面 Agent Runtime](../../rejected/architecture/2026-10-11-pi-agent-runtime-for-conversation.md)

## 提案

### 1. 定位：CLI 是第三个宿主，coding 是独立领域

- `apps/cli` 是可启动单元；`packages/tui` 是纯终端渲染库。
- `coding` 是与 `conversation`、`interview`、`answer` 平级的新领域，拥有自己的 Bot、prompt、policy 和会话用例；不 import `conversation/*` 或 `interview/*`，不启动 VAD/ASR。
- CLI 与 desktop 共享 `core/*`（Agent runtime、工具、transcript 与其投影）、事件与快照 schema；不共享 Electron、窗口和 DOM UI。
- CLI 在进程内直接组合，不使用 worker 线协议；未来 attach 桌面时再通过 `AgentTransport` 复用现有连接域。

### 2. v1 只跑通 CLI 自己的 coding Bot

```text
id: coding.engineer            domain: coding
modelRoute: chat
policy: coding 专用 prompt + 完整编码工具授权
tools: workspace.read / workspace.grep / workspace.edit /
       workspace.run-command / workspace.write-stdin
```

- 身份独立于桌面通用助手：名称、role、responsibility、owns 都由 `coding/agent.ts` 定义；不复用 `GENERAL_IDENTITY` / `GENERAL_DISCOVERY`。
- policy 独立于 `general-chat`：编码 prompt 强调先查看再修改、用工具验证、遵守工作区 `AGENTS.md`、不猜测文件内容、最终回复简洁；不改 `CHAT_PROFILES`。
- 模型上下文由 `coding/context.ts` 组装：从 `ConversationStore` 读历史、经 `core/transcript/projection` 投影，再追加本轮用户输入；不 import `conversation/turn`，也不复制桌面对话的时间/工作区策略。
- 工作区根取 `process.cwd()`，启动时调用 `CodingApplication.setWorkspaceRoot`。
- 单 Bot 会话，seed 为 `{ activeAgentId: coding.engineer, participantAgentIds: [coding.engineer] }`；没有可见 Bot，也没有交接入口。
- 多 Bot、team preset、模型自动交接全部后置。v1 不实现 `AgentDefinition.result` 的真实产出。

### 3. VAD-free 组合根与独立 CodingApplication

CLI 不调用 `startAgentHost`，也不复用 `ConversationApplication`。新增 `CodingApplication`，只保留 CLI 需要的单 Bot 生命周期：

- `createConversation` / `getSnapshot` / `readEventsAfter` / `clearConversation`
- `send(conversationId, request, accessToken)`：校验请求、`beginRun`、启动 executor、把事件写回 store
- `setWorkspaceRoot` / `configure` / `cancel` / `waitForRun` / `dispose`
- 不提供 `sendChat`、`sendTeamMessage`、Bot 目录选择、team preset 或 handoff 链。

`startCodingHost` 在 `apps/agent/src/coding/host.ts` 装配：

```text
AgentRuntime(emitEvent -> CLI 事件队列)
  + createBuiltinToolRegistry(...)
  + createCodingAgentDefinition({ store, tools })
  + CodingBot({ identity, policy, executor })
  + CodingApplication({ agentRuntime, store, bot, onSnapshot -> TUI })
```

- `CodingApplication` 直接持有单个 `CodingBot`，不构造 catalog；`BotDomain` 的 `"coding"` 只用于描述符和未来多 Bot。
- 首次发送前调用 `configure({ chat, answer })`；answer 路由复用 chat 配置，v1 不启用 Answer。
- `tokenProvider` 从 CLI 本地配置返回 API key；`auth: "local"` 的端点允许空 token。
- `startCodingHost` 从 `@answra/agent/composition` 导出，CLI 不需要知道内部目录，也不走 desktop 的 main 入口。

### 4. 模型与凭据独立于桌面

- 在 `packages/shared/src/env.ts` 唯一定义新增变量：
  - `ANSWRA_MODEL`：必填模型 ID。
  - `ANSWRA_API_KEY`：可选；本地 OpenAI 兼容端点可留空。
  - 复用现有 `ANSWRA_AI_BASE_URL`。
- 读取顺序：环境变量优先，CLI 参数覆盖；v1 不读桌面 `safeStorage`，不依赖登录态。
- 云端订阅登录后置。明确不通过读取桌面加密配置文件来“借用”凭据。

### 5. TUI：行为 1:1，代码不 1:1

原则：移植 Ink 引擎行为，按 Claude Code 的布局和交互重写所需组件；不直接搬运 `src/components` 的 React Compiler 编译产物。

引擎移植范围（`packages/tui`）：

- 必须：`dom`、`reconciler`、`ink`、`root`、`renderer`、`output`、`frame`、`screen`、`styles`、`render-node-to-output`、`render-border`、`measure-text`、`layout`、Yoga 的 TypeScript port、`termio`、`cursor`、`focus`、`events`。
- 组件：`Box`、`Text`、`ScrollBox`、`AlternateScreen`、`App`、`Spacer`、`Newline`、`StdinContext`、`TerminalSizeContext`。
- Hooks：`useInput`、`useStdin`、`useApp`、`useTerminalSize`、`useAnimationFrame`。
- 后置：搜索高亮、鼠标选择、bidi、hyperlink、tab 状态、terminal query、vim 模式。

必须解耦的 Claude Code 内部依赖：

- `ScrollBox` 的 `bootstrap/state.markScrollActivity` → 局部滚动状态。
- `ThemeProvider` 的 `utils/config` / `systemTheme` → CLI 自己的 ANSI 主题上下文。
- `bun:bundle` 的 `feature()` → 常量或构建期 define。
- `react/compiler-runtime` → 组件使用普通 TSX；引擎文件去掉 `_c` 记忆化。
- analytics 与 `utils/debug` → CLI 本地日志。

v1 业务组件：

- `App` / `AlternateScreen` 全屏布局；`Transcript` / `MessageRow` / `Message`。
- `Markdown`：正文、代码块、表格、链接。
- `PromptInput`：多行输入、历史、Enter 提交、Esc/Ctrl-C 取消；v1 不做 slash 自动补全。
- `StatusLine`：模型、cwd、当前 Bot、运行态。
- `Spinner` 与工具运行状态。
- `Diff`：直接消费 `EditOutput.diff` 的 `EditDiffDisplay`，不在终端重新计算。

投影复用：

- `@answra/ui` 增加 `./conversation-view` 子入口，只导出 `applyConversationSnapshot`、`applyAgentEvent`、`ConversationView`、`ConversationViewMessage`，不引入 React DOM。
- CLI 以 snapshot 初始化、以事件增量更新；`text-delta` 等高频事件先入队，每 16–33ms 批量提交给 Ink，避免每个 delta 触发一次 render。
- 不在 CLI 重写消息、part 或工具状态机。

### 6. 终端与平台

- 支持 Windows Terminal / ConPTY；提供 `--no-alt-screen` 和“非 TTY 纯流式输出”降级。
- 旧 conhost 的 VT、鼠标与宽字符能力不保证；验收环境固定为 Windows 11 + Windows Terminal。
- 键盘：Enter 提交；Shift+Enter 换行（终端不支持时用 Ctrl+J）；Esc 取消当前 run；Ctrl-C 首次取消、再次退出。
- 输出被重定向时不写 ANSI 控制序列，退化为逐行文本。

### 7. 明确不做

- 不修改 `core/*` 的事件或状态 schema；新增 `coding` 领域，但不改共享执行语义。
- 不复用 `conversation.general`、`general-chat`、`ConversationApplication`、`sendChat`、team preset 或 handoff；不把 coding profile 放进 `conversation/profiles/registry.ts`。
- 不做多 Bot、team、handoff、subagent-as-tool。
- 不做工具审批或沙箱；shell 仍是 Agent 进程权限，与桌面现状一致。
- 不做磁盘持久化、会话恢复、跨会话记忆。
- 不做桌面 attach、token 共享或本地监听。
- 不复制 Claude Code 的 Anthropic 版权组件源码；只复刻行为与布局。

## 实现进度与运行时下限

截至 2026-11-12，CLI 入口与非 TTY 一次性链路已经落地，TUI 尚未开始：

- `apps/agent/src/coding/` 已完成独立 `coding.engineer` Bot、policy、context、`CodingApplication` 与 `startCodingHost`；`@answra/agent/composition` 已公开该入口。
- `apps/cli/` 已完成 `main`、`cli`、`config`、`session`、`adapters`、`presentation`、`transport` 分层；`answra code` 支持 prompt、非 TTY stdin、help/version、正确退出码。
- CLI 产物构建目标固定 `node20.9`，runtime floor 为 Node 20.9；仓库开发/CI 仍是 Node >=22.13，两者不是同一运行时。
- 当前没有 `packages/tui` 或 `--no-alt-screen`；TTY 无 prompt 会明确报“TUI 尚未接入”，不伪装成交互界面。
- CLI bundle 已接入 answer/full 安装包：`apps/desktop/scripts/cli-packaging.mjs` 注入 `extraResources`（`../cli/dist` → `resources/cli`）和 Windows `extraFiles`（`resources/cli/answra.cmd` → `answra.cmd`）；`dist:win`/`dist:mac` 先执行 `build:cli`。安装目录审计检查 `resources/cli/main.cjs` 与 Windows shim。

运行时选择：

- 桌面继续锁定 Electron 29.4.6（Node 20.9、Chromium 122）。仓库已实测 39.0.0 和 44.7.0 出现捕获保护回归，29.4.6 是当前唯一通过的基线。
- 第一个带 Node 22 的 Electron 是 35.0.0（Node 22.14.0、Chromium 134），但它未通过本仓库的 Windows 捕获 A/B；不能因为 CLI 需要 Node 22 就升级 Electron。
- 安装包分发不新增 85MB Node 22 sidecar：CLI bundle 约 5.8MB，随安装包分发后由已安装的 `Answra.exe` 以 `ELECTRON_RUN_AS_NODE=1` 执行。已验证 Electron 29.4.6 的 Node v20.9.0 可运行 CLI bundle、访问本地 OpenAI-compatible SSE 端点并以 0 退出；打包后的 `release/win-unpacked/Answra.exe` 与 `resources/cli/main.cjs` 也通过同一 smoke。`pnpm --filter @answra/desktop dist:win` 已成功生成 NSIS，安装包内容包含 `answra.cmd` 与 `resources/cli/main.cjs`。
- 若未来 CLI 真的需要 Node 22-only API，再单独评估 Node 22 sidecar 或 Electron 升级；两项都必须另建 Note，并分别承担体积和隐身回归成本。

## 模块边界

- `apps/agent/src/coding`：CLI coding 领域；只 import `core/*` 与 `@answra/shared`，不 import `conversation/*`、`interview/*`、CLI 或 TUI。
- `apps/agent/src/conversation`：桌面通用对话；保持现有 prompt、profile 和上下文构建，不新增 coding profile，不感知 CLI。
- `apps/agent/src/core/transcript`：跨领域 transcript 与投影；不放领域 prompt、Bot 身份或工具授权。
- `packages/tui`：终端布局、渲染、输入、ANSI、滚动与 alt-screen；不 import `@answra/agent`、`@answra/shared`，不含 coding 业务。
- `apps/cli`：组合根、模型配置、view store、业务 TUI 组件与非 TTY 降级；可 import `@answra/agent/composition`、`@answra/shared`、`@answra/ui/conversation-view`。
- `packages/ui`：DOM 业务 UI；只新增纯投影子入口，不 import Ink 或 CLI。
- `packages/shared`：跨进程/跨宿主契约；新增 env 常量，不放 TUI 组件或 Ink 类型。
- `scripts/architecture`：允许 `apps/cli/src`、`packages/tui/src` 使用 `node:`；仍禁止本地监听和 Electron 依赖。

## 曾考虑的替代方案

- **让 CLI 复用 `startAgentHost` 并注入假 VAD/ASR：** 舍弃。coding 不需要媒体管线，假实现会掩盖依赖，并把 interview 的资源加载与错误路径带进 CLI。改为公开 coding-only 组合原语。
- **复用 `conversation.general` Bot，只换一个 coding prompt：** 舍弃。桌面通用 Bot 的身份、发现、profile 和 `ConversationApplication` 的 team/handoff 语义都是为悬浮条对话设计的；CLI 借用它会把未打磨的桌面策略和团队编排带进来，也无法独立演进。改为新增 `coding` 领域。
- **把 coding profile 加进 `conversation/profiles/registry.ts`：** 舍弃。这样仍让 CLI 依赖 `conversation` 域的类型和用例，违背“CLI 自己的 Bot”；profile 注册表也会混入两个产品面的策略。
- **CLI 通过 Electron utility process 启动桌面 worker：** 舍弃。违背“Agent 脱离桌面也能跑”，要求桌面常驻，CI/SSH 不可用，还会把模型凭据绑在 `safeStorage`。
- **直接复制 Claude Code 的 `src/ink` 和 `src/components`：** 舍弃为 v1 方案。组件是 React Compiler 产物，耦合 `AppState`、analytics、`bun:bundle`，代码量大且维护不可控，还有版权风险。改为移植引擎行为并重写所需组件。
- **先用纯 readline 文本 REPL：** 舍弃。用户明确要 Claude Code 的 TUI 观感；文本 REPL 无法验证全屏、滚动、工具卡和 diff 这些核心交互。
- **把纯投影抽成新的 headless 包：** 暂不。CLI 是第二个消费者，抽取合理，但会同时改 `packages/ui` 的导入与测试；v1 先用 `./conversation-view` 子入口，等出现第三个消费者或边界变脏再抽。
- **v1 直接做多 Bot、team 与自动交接：** 舍弃。真实交接结果产出尚未实现，且 CLI 首要是跑通 TUI；单 Bot 已能验证全部 TUI 交互。
- **引入通用 TUI 框架（blessed/OpenTUI）：** 舍弃。目标是复刻 Claude Code 的 Ink 行为；换框架会重写滚动、布局、输入和渲染语义。
- **为 CLI 升级 Electron 到带 Node 22 的版本：** 舍弃。Electron 35.0.0 才带 Node 22，但 39/44 已实测捕获保护回归；CLI 不应倒逼桌面放弃已验证的 29.4.6 隐身基线。
- **随安装包再带一个 Node 22 sidecar：** 舍弃。约 85MB，且与现有“复用 Electron 内置 Node”的边界冲突；CLI 当前没有 Node 22-only API。
- **安装包复用 Electron 二进制作为 Node 运行时：** 采用。`ELECTRON_RUN_AS_NODE=1` 只运行 Node 逻辑，不创建窗口；CLI bundle 约 5.8MB，不新增 sidecar。已在 Electron 29.4.6 / Node v20.9.0 上完成 CLI 与本地假模型端点 smoke。

## 验收标准

- 可观察结果：
  - `answra code` 在系统 Node 20.9+ 或 Electron 29.4.6 Node 模式、无 VAD/ASR 资源的 Windows 11 + Windows Terminal 上启动。
  - 输入编码指令后，TUI 依次显示思考、文本、工具调用、工具输出和最终回复；Ctrl-C 能取消。
  - Edit 调用显示多 hunk diff；Read、Grep、RunCommand 有独立工具卡。
  - 非 TTY 或 `--no-alt-screen` 时退化为逐行流式输出，不崩溃。
- 自动化验证：
  - `pnpm --filter @answra/tui test`：布局、滚动、输入、ANSI 宽度与 alt-screen 状态。
  - `pnpm --filter @answra/cli test`：命令语法、模型配置、工作区、会话状态机、事件呈现、版本一致性与非 TTY 降级；当前 39 个用例。
  - `pnpm --filter @answra/cli smoke:electron`：构建后由 Electron 29.4.6 Node 模式执行 help/version/错误路径与本地假 SSE。
  - `pnpm --filter @answra/desktop test`：CLI `extraResources`/`extraFiles` 配置与 Windows shim 内容。
  - `pnpm --filter @answra/agent test`：`coding` 的 profile 授权、单 Bot 会话、取消与 transcript；`conversation` 既有测试保持不变。
  - `pnpm architecture:check`、`pnpm notes:check`、`pnpm verify` 通过。
- 需要的实机验证：
  - Windows 11 + Windows Terminal：中文、宽字符、长输出滚动、工具卡展开、diff 渲染和 Ctrl-C。
  - 非 TTY（管道）下输出可被重定向，不泄漏 ANSI 控制序列。

## 风险

- Ink fork 的引擎移植是主要工作量；React 19 与 `react-reconciler` 版本对齐需要先做 spike，失败会阻塞 TUI。
- `coding` 会重复少量消息组装逻辑（历史投影 + 本轮输入）；v1 接受，避免把桌面对话的时间/工作区策略拉进 CLI。若两个领域继续收敛，再抽共享构建器。
- `CodingApplication` 与 `ConversationApplication` 会出现小范围会话循环重复；v1 接受，避免把 team/handoff 语义带进 CLI。若两者继续分叉，再抽共享的单 Bot application 原语。
- 终端能力差异大：旧 conhost、VS Code 集成终端、SSH 终端对 alt-screen、鼠标和宽字符支持不同；v1 只保证 Windows Terminal，其他环境走降级。
- 版权与维护：Claude Code 是 Anthropic 还原源码，引擎与组件只能行为复刻，不能整段粘贴；引入 MIT 上游代码时必须保留声明并记录来源。
- 无审批的 shell 是任意命令执行，与桌面现状一致，但 CLI 更容易被脚本化；后续审批必须单独写 Note。
- 模型配置走环境变量会在 shell 历史和进程环境中暴露 key；v1 接受，后续做本地配置文件或 OS keychain。
- 内存 transcript 退出即丢，用户可能误以为可恢复；启动文案和 `--help` 必须明确。
- 放宽 `node:` 白名单会扩大平台依赖面；必须只放行 `apps/cli/src`、`apps/cli/scripts` 和 `packages/tui/src`，仍禁止本地监听与 Electron 依赖。
- CLI 复用 Electron 29.4.6 的 Node 20.9 意味着 CLI 也继承该版本的维护期风险；Electron 升级必须另行完成 Windows 捕获 A/B，不能用 CLI 需求绕过。
- Windows shim 不自动注册 PATH；用户需使用安装目录内的 `answra.cmd` 或手动加入 PATH。macOS/Linux 当前只分发 CLI bundle，尚未提供 POSIX shim。
