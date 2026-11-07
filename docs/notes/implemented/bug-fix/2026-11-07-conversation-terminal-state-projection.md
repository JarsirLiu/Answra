# Note：Conversation UI 消费 Agent run 终态

状态：已实施

## 问题

统一事件流迁移后，Agent 已通过 `run-state-changed` 发出 run 终态，但 UI reducer 仅处理了失败态。成功态仍保留 assistant 消息的 `streaming` 状态，导致消息没有进入完成态；被取消或替代的 run 也可能继续呈现为流式消息。失败后的 retry 指示也没有按既有决策停止动画。

## 涉及范围

- 代码/模块：`packages/ui/src/app/conversationView.ts`、`packages/ui/test/conversationView.test.ts`、`packages/ui/src/components/chat/conversationMessage.ts`
- UI/进程/协议/持久化表面：Agent run 终态事件到 Conversation 消息展示状态的唯一 UI 投影
- 相关 Note：`docs/notes/implemented/architecture/2026-11-07-single-agent-event-stream.md`、`docs/notes/implemented/architecture/2026-11-06-rate-limit-retry-and-indicator.md`

## 决定

继续使用现有 `run-state-changed` 作为唯一终态事实，不恢复 `run-finished` 第二事件。UI reducer 对所有终态做明确映射：`completed` 到消息 `complete`，`failed` / `orphaned` 到 `failed`，`aborted` / `superseded` 到 `interrupted`。所有终态都清除该 run 的活动标记和思考状态；取消/替代只结束本轮，不添加“已中断”提示。

当失败终态属于当前重试 run 时，将已记录的 retry 指示标为结束，只保留静止 Wi-Fi 图标；不显示重试结束文案或次数。成功或非失败终态清除该 run 的 retry 指示。

## 根因

终态 reducer 清除了 `activeRunId`，但只将 `failed` 映射到消息状态；`completed`、`aborted`、`superseded` 和 `orphaned` 沿用了旧的 `streaming` 状态。此前 `ConversationStore.finishRun()` 生成的 `run-finished` 通知已被移除，但其 UI 终态职责没有完整迁移到 `run-state-changed` reducer。

## 修复

为终态事件添加显式状态映射，并按终态清理活动思考与重试等待展示。用 reducer 测试覆盖成功、失败、取消、替代及孤立终态，以及失败保留静止 Wi-Fi 指示。

## 曾考虑的替代方案

- **重新增加 `run-finished` 事件：** 舍弃，因为它与 `run-state-changed` 重复表达同一 run 终态，会恢复双事件来源。
- **在组件里根据 `activeRunId` 消失推导消息完成：** 舍弃，因为状态需由明确的终态事件提供，且该推导无法区分成功、失败和取消。

## 验收标准

- `completed` 后 assistant 消息不再处于 `streaming`，完成操作条可以出现。
- `failed` 映射为失败终态；若有 retry 记录，则 Wi-Fi 图标静止并保留。
- `aborted` / `superseded` 映射为已结束状态，不显示“已中断”说明或等待中的 retry 动画。
- 不新增终态事件种类。
- 自动化验证：UI 定向测试、`pnpm notes:check`、`pnpm verify`。

## 风险

- 该修复消费已经存在的终态事件；若 Agent 没有发出 `run-state-changed` 终态，UI 不会通过计时器或流结束顺序伪造完成状态。

## 后果与防回退

- Agent 仍只通过 `run-state-changed` 发送 run 终态；UI 不得重新引入 `run-finished` 或按流结束顺序猜测消息状态。
- 五种终态必须映射到明确的 Conversation 消息状态；新增终态时必须同步更新映射和测试。
- retry 指示只由当前 run 的 retry 事件与终态事件维护；失败保留静止记录，成功或取消清除等待记录。

## 验证

- `pnpm --filter @answra/ui test -- conversationView.test.ts`：10 个测试通过。
- `pnpm --filter @answra/ui typecheck`：通过。
- `pnpm notes:check`：通过。
- `pnpm verify`：Biome、全包 typecheck、641 个测试及架构检查通过。
- `git diff --check`：通过。
