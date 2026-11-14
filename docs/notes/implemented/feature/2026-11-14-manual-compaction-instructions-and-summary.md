# Note：手动压缩的自定义摘要指令与摘要展示

状态：已实施

## 问题

Answra 已有手动压缩入口，但 `/compact` 不接受参数，用户无法说明摘要应重点保留什么；TUI 只显示一行压缩边界，摘要正文和消息计数被留在 Agent store，用户无法确认压缩结果。Claude Code 的 `/compact [instructions]` 会把用户指令追加到摘要 prompt，并在 transcript 中显示可展开的摘要与“Summarized N messages”。当前行为与这一交互不一致。

本变更只补手动压缩的用户可控性与可观察性，不引入 partial compaction、hooks、session memory 或自动压缩开关。自动压缩继续默认开启，不提供关闭开关。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/core/context/compaction/`：摘要 prompt、checkpoint、边界投影。
  - `apps/agent/src/core/context/preparation.ts`：手动压缩参数、trim 与长度校验。
  - `apps/agent/src/conversation/application.ts`、`apps/agent/src/coding/application.ts`：把一次性指令传到压缩核心。
  - `apps/agent/src/worker/protocol.ts`、`apps/desktop/src/main/agent/agentService.ts`、`apps/desktop/src/main/conversation/conversationIpc.ts`、`apps/desktop/src/preload/index.ts`：桌面链路透传与 IPC 校验。
  - `apps/cli/src/session/codingSession.ts`、`apps/cli/src/adapters/agentCodingHost.ts`、`apps/cli/src/tui/commands/`、`apps/cli/src/tui/runTui.tsx`：CLI `/compact [instructions]`。
  - `apps/cli/src/tui/transcript/`：压缩边界行、摘要展开和虚拟高度估算。
- UI/进程/协议/持久化表面：
  - `ContextCompactionBoundary` 增加摘要正文、累计摘要消息数和可选手动指令；snapshot 可回放。
  - `ManualCompactionResult` 不新增摘要正文，结果仍只表达状态、usage 和错误。
  - CLI 使用现有 `Ctrl+O` 展开摘要；不新增第二个历史面板。
  - 自动压缩、provider 超限恢复不读取自定义指令。
- 相关 Note：
  - [会话上下文摘要压缩与旧上下文归档](../../proposed/architecture/2026-11-13-conversation-context-compaction-and-archive.md)
  - [Provider 上下文超限的单次恢复](../architecture/2026-11-14-provider-overflow-reactive-compaction.md)

## 影响表面

- CLI：`/compact 重点保留数据库迁移决定` 生成偏重指定内容的摘要；压缩后 `Ctrl+O` 查看摘要、消息计数和指令。
- 桌面：手动压缩仍可一键触发；IPC/worker 已支持可选指令，当前 UI 不收集指令，也不展示摘要正文。
- 协议：手动压缩请求增加可选 `instructions`；压缩边界增加摘要、累计消息数和可选指令。
- 隐私与载荷：摘要正文随 snapshot 下发到桌面和 CLI，但不进入普通消息、日志或新的模型请求位置。

## 决定

1. `/compact [instructions]` 把手动输入的剩余文本作为一次性 `instructions`，经 CLI 端口、worker/IPC/桌面 preload 传到 `ContextPreparation.compactNow`。
2. `ContextPreparation` 在调用模型前 trim 指令；空串视为未提供；超过 `MANUAL_COMPACTION_INSTRUCTIONS_MAX_CHARS`（4,000）直接 fail-closed。桌面 IPC 使用同一上限提前拒绝。
3. `buildSummaryPrompt` 在基础摘要 prompt 与待压缩 transcript 之后追加“用户附加摘要指令”区块；基础约束（只输出摘要、不编造、事实准确和隐私边界）不可被覆盖。
4. `ContextCheckpoint` 保存可选的 `instructions`；`ContextCompactionBoundary` 投影 `summary`、累计 `summarizedMessages` 和可选 `instructions`。指令不进入 transcript 普通消息、不写入共享配置；它只随本次 checkpoint 用于边界展示。
5. 桌面按钮仍发送无指令压缩；桌面链路保留可选参数，后续 UI 可复用。
6. CLI 压缩边界默认只显示 Claude 风格边界行；`Ctrl+O` 展开后显示“Summarized N messages up to this point”、可选 `Context: “…”` 和摘要正文。
7. 不新增自动压缩开关；自动压缩和自动工具清理保持默认开启。
8. 手动压缩返回 `failed` 时，CLI 现在显式显示错误，不再静默清除提示；`aborted` 仍显示“已取消压缩”。

## 曾考虑的替代方案

- **只把摘要放在 `ManualCompactionResult`，不进入 snapshot：** 舍弃。CLI 压缩后通过 snapshot 更新边界，结果对象只在调用点短暂存在；重启/重连回放时摘要无法展示。把摘要作为边界元数据与 Claude Code 的 transcript 行为一致。
- **新增独立“压缩摘要消息”进入 transcript：** 舍弃。会改变消息顺序、run 回放和普通消息投影，成本高于在边界上携带展示元数据。
- **新增摘要读取 IPC，按需拉取正文：** 舍弃。摘要本来已存在于内存 `ContextState`，为展示再加一条请求/失效链路，收益不足。
- **把自定义指令写进会话或共享配置：** 舍弃。它是一次性摘要偏好，不是会话事实或全局设置；持久化会让后续自动压缩意外继承。
- **同时增加自动压缩开关：** 舍弃。用户明确要求自动压缩默认常开；关闭后上下文超限的风险大于配置收益。

## 后果与防回退

- 摘要正文进入 snapshot 会增加一次 IPC 载荷；摘要上限仍由模型输出和压缩请求约束，UI 只在展开时渲染。桌面不展示正文。
- 自定义指令可能与基础约束冲突；prompt 明确基础事实准确性、隐私和不编造优先，但模型仍可能不完全遵守，不能把指令当作硬安全边界。
- 手动指令属于用户输入，必须在 Agent 入口和桌面 IPC 两处保持长度上限；删除任一处都会让超长输入进入 prompt。
- 边界行必须继续由 `Ctrl+O` 控制展开；不要新增与工具展开无关的第二个摘要开关，避免两个展开状态漂移。
- 自动压缩与 provider 超限恢复不得传入 `compactionInstructions`；新增领域接线时只能从手动入口传。

## 验证

- `apps/agent/test/core/context/compact.test.ts`：基础 prompt 保留，附加指令出现在 transcript 之后并写入 checkpoint。
- `apps/agent/test/core/context/preparation.test.ts`：指令 trim 后进入 prompt；超长指令在调用模型前 fail-closed；手动压缩直接显示摘要错误。
- `apps/agent/test/core/transcript/contextState.test.ts`、`store.test.ts`：边界投影包含摘要、累计消息数和指令。
- `apps/cli/test/session/codingSession.test.ts`、`runTui.test.ts`：`/compact 参数` 作为一次性指令传入会话；手动压缩仍不发送普通 prompt。
- `apps/cli/test/tui/app/tui.compaction.test.tsx`：摘要默认折叠，`Ctrl+O` 后显示摘要、消息计数与指令。
- `apps/desktop/test/conversationIpc.test.ts`：IPC 透传指令并拒绝超长输入。
- 自动化结果：Agent 73 文件 / 544 测试、CLI 45 文件 / 275 测试、Desktop 52 文件 / 329 测试、Shared 3 文件 / 31 测试通过；完整 `pnpm verify`（Biome、全包 typecheck、vitest、架构守护、tokens 与 Note 提示）通过。
- 未做真实终端人工验收；桌面手动压缩仍需实际点击确认无回归。
