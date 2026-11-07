# Note：AI SDK fullStream 作为 Agent 模型事实源

状态：已实施

## 问题

当前 Conversation 回合消费 `result.toUIMessageStream()`，并把其中一部分 `UIMessageChunk` 归一化为 `AgentStreamEvent`。这条路径面向 UI 消息传输，当前适配会丢弃 AI SDK 的 step 开始/结束、生成完成、取消、部分工具生命周期和文件等信号。回合终态又在执行收尾逻辑中单独判断，导致模型流事实、run 状态和 UI 终态之间缺少完整且可回放的来源。

## 涉及范围

- 代码/模块：`apps/agent/src/core/model/`、`apps/agent/src/conversation/turn/`、`packages/shared/src/schema/`、`packages/ui/src/app/conversationView.ts`
- UI/进程/协议/持久化表面：Agent 模型流归一化、唯一 `AgentEventEnvelope` 事件流、run/step 状态缓存、Conversation/答题/面试回复的 UI 投影
- 相关 Note：`docs/notes/implemented/bug-fix/2026-11-07-conversation-terminal-state-projection.md`

## 决定

### 1. 唯一模型事实源

Conversation 回合改为消费 AI SDK `streamText()` 返回值的 `result.fullStream`。`fullStream` 是 AI SDK 提供的模型事件流，包含生成开始/完成/取消/错误、step 生命周期、文本、reasoning、工具输入与执行结果、来源和文件等事件。

`result.toUIMessageStream()` 保留为 AI SDK 的 UI 传输投影能力，但不再作为 Agent 事实事件的来源，也不与 `fullStream` 并行写入事件 store。当前 UI 继续消费 `AgentEventEnvelope`，因此不直接把 AI SDK 类型暴露到 `packages/shared`。

### 2. 事件归一化边界

`apps/agent/src/core/model/` 消费 AI SDK `TextStreamPart` 并转换为 `@answra/shared/schema` 中的 provider-neutral 事件。转换保留当前 schema 可表达的生命周期和关联 ID：

- 生成生命周期：start、finish、abort、error
- step 生命周期：step-started、step-finished
- 内容生命周期：text-start/delta/end、reasoning-start/delta/end
- 工具生命周期：tool-input-start/delta/end、tool-call、tool-result、tool-error、tool-output-denied、tool-approval-request
- 资源事件：source-url、source-document、file

AI SDK 的 provider metadata、原始响应 body 和 SDK 专属对象不进入稳定共享 schema；需要诊断的字段只能在明确的 schema 字段中保留。

现有事件名称继续复用。新增事件只在 AI SDK 已提供且当前共享 schema 无法表达的事实确实需要时增加，不引入第二套 `RunEvent`、`OutputEvent` 或 UI 专属事实事件。

### 3. 状态的显式来源

状态不是从“流循环结束”或事件顺序猜出来的：

- `run-state-changed` 是应用 run 状态变化事件；其迁移由 `apps/agent/src/execution/status.ts` 校验。
- AI SDK `finish` 只能证明模型生成正常结束；只有执行组合根明确收到该事实后，才允许追加 `run-state-changed: completed`。
- AI SDK `abort` 只能证明模型流被取消；执行组合根据此追加 `run-state-changed: aborted`。
- AI SDK `error` 事实导致异常收尾时，执行组合根追加 `run-state-changed: failed`。单个 tool error 作为工具事实记录，不自动判定整个 run 失败，因为模型可能继续处理。
- 没有收到 finish、abort 或 error 时，不得把迭代器自然结束推导为成功。

事件 store 在收到 `run-state-changed` 时同步维护当前状态缓存。当前 store 是进程内实现，尚未提供事件重放或进程重启恢复；本次只保证同一事件流是状态变化的显式来源，不宣称已具备恢复能力。UI 只从同一事件流做投影。

### 4. 持久化和消费边界

当前仍使用进程内 `ExecutionStore`。本提案不增加数据库或 Redis，也不新增 Conversation 事件日志。未来持久化只替换唯一事件 store，状态缓存、transcript 和 UI 状态继续从明确来源重建。

## 模块边界

- `apps/agent/src/core/model/`：只依赖 AI SDK，负责模型流到稳定事件的归一化。
- `apps/agent/src/execution/`：负责事件 envelope、run/step 状态迁移、事件 store 和状态缓存；不依赖 React 或 UI stream。
- `apps/agent/src/conversation/turn/`：组合模型调用、事件写入和终态收尾；不定义共享事件 schema。
- `packages/shared/src/schema/`：唯一跨包稳定 schema；不导入 AI SDK。
- `packages/ui/`：只从 `AgentEventEnvelope` 投影界面状态，不消费 AI SDK 原始流。

## 曾考虑的替代方案

- **继续使用 `result.toUIMessageStream()` 作为 Agent 事实源：** 舍弃。它是 UI 消息传输投影，无法完整表达 `fullStream` 的 step、模型完成、取消和工具生命周期；当前实现已经证明会丢事件。
- **同时消费 `fullStream` 和 `toUIMessageStream()`：** 舍弃。两条写入路径会产生重复或顺序不同的事实，形成状态漂移风险。
- **把 AI SDK `UIMessageChunk` / `TextStreamPart` 直接放进 shared：** 舍弃。跨进程契约会被 provider SDK 类型绑定，且无法控制版本升级和供应商字段泄漏。

## 验收标准

- 可观察结果：普通对话、答题和面试回复都从同一 `AgentEventEnvelope` 看到文本、推理、工具、step、完成、取消和错误事件；成功、异常、取消三种终态均有明确 `run-state-changed` 事件。
- 自动化验证：归一化测试覆盖保留的 start/finish/abort/error、step、内容、工具、source/file 事件；全包类型检查、测试和架构门禁通过。
- 需要的实机验证：接入至少一个支持 reasoning 和 tool calling 的 OpenAI-compatible endpoint，确认事件顺序、工具执行和取消行为；未实测前不宣称所有 provider 字段兼容。

## 风险

- 不同 provider 可能不发送 reasoning、tool 或 raw 事件；缺失能力必须表现为缺失事件，不得伪造状态。
- `fullStream` 的类型包含 `unknown` 输出和 provider metadata；归一化必须在 Agent 边界收窄，不能把未知对象直接暴露给 UI。
- 当前事件 store 仍是进程内实现，进程重启恢复不在本提案范围内。

## 后果与防回退

- `executeTurn` 只消费 `result.fullStream`；不得再从 `toUIMessageStream()` 并行写入 Agent 事件。
- AI SDK 类型只停留在 `apps/agent/src/core/model/`；shared schema 是唯一跨包契约，run 状态迁移仍由 `apps/agent/src/execution/status.ts` 校验。
- `finish`、`abort`、`error` 是模型流事件；应用终态继续通过 `run-state-changed` 表达。没有明确模型终止事实时，回合按异常结束处理。

## 验证

- `pnpm --filter @answra/agent typecheck`：通过。
- `pnpm --filter @answra/agent test`：21 个测试文件、140 个测试通过。
- `pnpm notes:check`：通过。
- `pnpm verify`：Biome、全包类型检查、shared 4 个测试、agent 140 个测试、UI 221 个测试、desktop 277 个测试及架构检查通过。
- `git diff --check`：通过。
