# Note：上下文用量按单次请求计，不按 step 求和

状态：已实施

## 问题

实机 CLI 状态行出现 `ctx 651.4k/256k`：用量超过窗口一倍多。同一份数据写入状态后，`usageAnchor` 记录为 `651448 / 9449`（约 69 倍），会被当成「实际/估算」的校准比例，下一次请求前的估算随之放大数十倍。

会话数据显示触发条件很短：一个 Turn 只有 1 个 session step，但该 step 里有 24 次工具调用（24 条 `tool-call` + 24 条 `tool-result`），也就是 AI SDK 在同一个 `streamText` 调用里跑了约 25 次请求。

## 涉及范围

- 代码/模块：
  - `apps/agent/src/core/agent/providerStepRunner.ts`：采集逐请求输入量。
  - `apps/agent/src/core/session/contracts.ts`：`StepRunnerResult.requestTokens`。
  - `apps/agent/src/core/context/preparation.ts`、`usageState.ts`：锚点与展示分开取数。
  - `apps/agent/src/{coding,conversation,interview}/application.ts`：把逐请求用量交给上下文层；coding 在 step 结束推一次快照。
- 测试：`apps/agent/test/core/agent/providerStepRunner.test.ts`、`apps/agent/test/core/context/preparation.test.ts`。
- UI/进程/协议/持久化表面：`ContextUsage.usedTokens` 语义不变（当前上下文占用），但来源改为最后一个请求；`usageAnchor.inputTokens` 改为首个请求。不新增事件、不改数据库结构。
- 相关 Note：[压缩成功后刷新上下文用量](../bug-fix/2026-11-20-refresh-context-usage-after-compaction.md)、[256k 上下文预算与旧工具结果清理](../architecture/2026-11-13-context-budget-and-tool-result-clearing.md)。

## 决定

`ContextUsage.usedTokens` 与 `usageAnchor` 改为读取同一 session step 内逐请求的 `usage.inputTokens`：展示取最后一个请求，锚点取第一个请求；`finish.totalUsage` 只保留为 Turn 总消耗，不再进入上下文展示或校准。

## 根因

`createToolStepLimit()` 给 `streamText` 设置了 `stopWhen: stepCountIs(21)`，一次 session step 内部会连续发起多次模型请求。AI SDK 的 `finish` 事件携带的是 `totalUsage`——官方定义就是「多步时所有 step 用量之和」；`finish-step` 才是单次请求的 `usage`。

本仓库把 `finish.totalUsage` 当成两件事的输入：

1. `ContextStateCoordinator` 把它写成 `ContextUsage.usedTokens`，UI 又把它和窗口并列展示；
2. 同一个值作为 `usageAnchor.inputTokens`，与发送前的估算比较，得到校准比例。

step 越多、工具循环越长，这两个数偏离真实上下文越大。24 次工具调用时，求和值自然超过窗口，锚点比例也随之失真。

## 修复

- `ProviderStepRunner` 通过 `onStepFinish` 记录本次 step 首个与最后一个请求的 `usage.inputTokens`，随 `StepRunnerResult.requestTokens` 返回。
- `ContextStateCoordinator.recordStepFinished` 拆分两个入参：
  - `anchorInputTokens`（首个请求）→ 只用于校准锚点；
  - `contextInputTokens`（最后一个请求）→ 写入 `ContextUsage.usedTokens`。
- `CodingApplication` 在 step 结算后立即推送一次 snapshot，使 CLI 状态行不必等 Turn 收口才刷新。
- `finish.totalUsage` 继续作为 `StepRunnerResult.usage` 保留，供 turn-end 统计总消耗，语义不变。

## 曾考虑的替代方案

- **把 `finish` 事件的 usage 改成 `finish-step` 的最后一个值：** 舍弃。`finish` 同时供给 turn-end 的总消耗统计，改掉会让「这一 Turn 花了多少 token」失去意义。
- **新增一条逐请求 usage 的 Agent 事件：** 舍弃。事件联合类型、durable/live 分类与两个投影都要同步，且 live 通道已不再承载会话级状态；这里只需要 runner 内部的事实。
- **继续用求和值、只把显示 clamp 到窗口：** 舍弃。数字看起来正常了，但锚点比例仍被放大，自动压缩会在错误时机触发。
- **端点未声明窗口时改用固定分母：** 本次不动。分母仍是兜底预算，显示语义与窗口未知的事实另议。

## 后果与防回退

- `StepRunnerResult.usage` 仍然是「本 session step 所有请求之和」，任何展示「当前上下文」的地方都不得取它，只能取 `requestTokens.lastInputTokens`。
- 锚点必须取首个请求：它与发送前估算描述的是同一个请求。取最后一个会让比例随工具轮数单调放大。
- `contextInputTokens` 缺失时不得回退到 `usage.inputTokens`；没有 provider 实测就不更新展示值。
- 每次 step 结算多一次 snapshot 推送，属预期开销；不要退回「只在 Turn 收口推送」，否则运行中状态行仍然停滞。

## 验证

- `pnpm --filter @answra/agent exec vitest run test/core/agent/providerStepRunner.test.ts test/core/context/preparation.test.ts`：44 项通过，包含「首个/最后一个请求输入分别上报、usage 仍为总和」与「锚点取首请求、展示取末请求」。
- `pnpm --filter @answra/agent typecheck`、`pnpm --filter @answra/ui typecheck`：通过。
- 实机验证：下一个多工具 Turn 结束后，状态行数字应等于最后一次请求的输入量，且明显小于窗口；`/status` 与状态行一致。
