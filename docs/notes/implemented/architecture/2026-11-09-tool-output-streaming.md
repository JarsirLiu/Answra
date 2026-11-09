# Note：长命令输出的实时增量更新

状态：已实施

## 问题

`RunCommand` 在 UI 上只有一次结果落点：命令结束前 `tool-execution-finished` 不触发，展开的 `Shell` 面板一直是空的；输出很长的 `dir` / `ls -la` / 构建命令在跑完之前看不到任何进展，用户无法判断命令是在运行、卡住还是失败。opencode 的 bash 工具通过 `ctx.metadata({ output })` 在命令运行期间持续刷新输出，Answra 需要等价能力。

## 涉及范围

- 代码/模块：
  - `packages/shared/src/schema/events.ts`：新增 live-only 事件 `tool-output-delta`。
  - `apps/agent/src/core/tool/contracts.ts`、`registry.ts`：`ToolContext` / `ToolSessionContext` 增加 `onOutput` / `onToolOutput` 回调。
  - `apps/agent/src/core/tool/builtin/shell/localShell.ts`、`tools.ts`：前台命令按 chunk 回报输出。
  - `apps/agent/src/core/agent/definition.ts`、`executeRun.ts`、`apps/agent/src/conversation/agent.ts`：把回调接到 `executeRun` 的事件日志。
  - `packages/ui/src/app/conversationParts.ts`：把增量累加进 tool part 的 `output`。
- UI/进程/协议/持久化表面：新增一个 renderer 与 agent 进程共享的事件 payload；不新增 IPC 频道、不改 transcript 持久化字段。
- 相关 Note：
  - [工具调用卡片的统一 UI 架构](../../implemented/architecture/2026-11-09-tool-call-ui-architecture.md)
  - [事件 schema 单一来源与 AI SDK 边界](../../implemented/architecture/2026-11-03-event-schema-single-source.md)

## 决定

- **事件**：`tool-output-delta { toolCallId, delta }` 放在 `liveOnlyStreamEventOptions`，与 `text-delta` / `reasoning-delta` 同级；它是高频实时事实，不进入 durable 候选。最终结果仍由 `tool-execution-finished` / `tool-result` 的完整输出覆盖。
- **数据流**：`LocalShell` 用 `StringDecoder("utf8")` 按 chunk 解码 stdout/stderr，通过 `ShellAction.onOutput` 上报；`ToolContext.onOutput` 由 registry 在构造 AI SDK tool 时绑定到当前 `toolCallId`；`executeRun` 把回调串行写入 journal，并在 `experimental_onToolCallFinish` 前 `flush()`，保证 deltas 一定先于工具终态。
- **UI 累加**：`applyConversationPartEvent` 在 tool part `state === "running"` 时把 delta 追加到 `output`（字符串），终态事件用完整输出覆盖；居后到达的 delta 因状态已不是 `running` 而被忽略，避免重复拼接。
- **渲染**：`RunCommand` 的 `parseShellOutput` 已经接受字符串 `output`，运行中显示原始 stdout/stderr；结束时字符串变成 `Exit code: …` 格式，仍按既有规则剥离状态行。
- **上限**：每个 `toolCallId` 的实时 delta 累计最多 `8_000` 字符；超过后停止发送实时增量，最终结果不受影响，避免长命令把事件日志撑爆。
- **不做**：不为 `WriteStdin` 会话快照额外建立持续推送；会话仍按模型每次 `WriteStdin` 调用的快照更新。不在 UI 里另建第二套 stdout 缓冲。

## 模块边界

- `core/tool` 仍不写事件：它只接收 `onOutput` 回调，不 import journal / execution store。
- `executeRun` 持有事件写入与排序；`conversation/agent.ts` 只把 emitter 透传给 `authorize`。
- `tool-output-delta` 的 payload 只来自 `packages/shared/src/schema/events.ts`；UI 不自定义第二个 delta 类型。
- `LocalShell` 的实时解码只服务预览，最终 `ShellOutputResult` 的编码回退（GBK）逻辑不变。

## 曾考虑的替代方案

- **轮询 `WriteStdin` 快照：** 舍弃。要求模型主动多次调用工具，用户看不到连续输出，且会把交互工具语义塞进只读命令。
- **按完整预览替换而非 delta：** 舍弃。每次发送完整输出会让事件体积随输出长度平方增长；delta 更小，且与现有 text/reasoning delta 投影一致。
- **让 renderer 定时轮询 agent 进程：** 舍弃。跨进程多一条拉取通道，状态来源分裂，违反事件是唯一事实来源的约束。
- **把 `tool-output-delta` 设为 durable：** 舍弃。高频增量不需要长期存储，最终结果已持久化；durable 会放大存储与重放成本。

## 后果与防回退

- 可观察结果：长命令运行期间，展开的 `Shell` 面板持续追加 stdout/stderr；命令结束后显示完整输出（去掉 `Exit code` 状态行）。
- 防回退约束：
  - 实时输出必须走 `tool-output-delta`，不得在 renderer 直接订阅子进程或另开 IPC。
  - 终态事件必须覆盖 `output`；delta 只允许在 `running` 状态累加。
  - 每个 tool call 的实时增量字符上限保持在 `executeRun`，不得无上限转发。
  - `core/tool` 不得 import journal；事件写入只留在 `core/agent`。

## 验证

- 自动化：
  - `apps/agent/test/core/tool/shell/localShell.test.ts`：`onOutput` 在命令结束前收到含 `hello` 的增量。
  - `packages/ui/test/conversationParts.test.ts`：`tool-output-delta` 累加为 `line 1\nline 2`，终态后到达的 delta 被忽略。
  - `packages/ui/test/toolCallRenderers.test.tsx`：完成态 Shell 面板文本、`Exit code` 剥离与无输出字符串回退。
  - `pnpm --filter @answra/shared|@answra/agent|@answra/ui typecheck`：通过。
- 需要的实机验证：`pnpm dev:full` 触发长命令（如 `dir /s` 或构建脚本），确认展开面板逐段增长、结束后停在完整输出。
