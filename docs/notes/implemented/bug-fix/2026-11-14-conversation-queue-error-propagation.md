# Note：会话队列保留完整回合异常

状态：已实施

## 问题

会话队列改造后，`ConversationApplication.sendTeamMessage` 等待到的失败只包含 `failed` 状态，不再携带启动完整回合时的原始异常。非法 Bot 交接因此被当作普通失败完成，调用方无法收到原先的 reject 行为。

## 涉及范围

- 代码/模块：`apps/agent/src/conversation/queue/conversationQueue.ts`、`apps/agent/src/conversation/application.ts`
- 用户行为：非法交接、启动失败或完整回合异常必须继续向同步团队发送入口抛出，队列内部仍以稳定的 `failed` 状态推进后续消息。

## 根因

队列只把完整回合 rejection 映射成 `failed`，完成结果没有保留原始异常；`sendTeamMessage` 因而只能返回最终 snapshot。

## 修复

队列完成结果保留内部 `failure.error`，由 `sendTeamMessage` 在等待完整回合结束后重新抛出；worker/CLI 继续只消费 `outcome`，不把异常对象放进跨进程协议。队列回归测试覆盖失败原因保留，Bot 选择与团队交接测试覆盖调用方 reject。

## 决定

保留队列的稳定完成状态，同时由同步团队入口恢复原始异常语义。

## 曾考虑的替代方案

- **让 `ConversationQueue.wait` reject：** 会破坏现有稳定完成状态和队列后续调度，舍弃。
- **在 `ConversationApplication` 重新推测失败原因：** 没有可靠来源，舍弃。

## 后果与防回退

同步团队入口恢复原有错误语义；异步队列观察者仍可按 `failed` 状态收敛，且错误对象不会穿过 worker 线协议。

防回退约束：队列测试必须断言失败原因仍可被拥有完整回合的应用读取，交接测试必须断言非法目标 reject 且不写入 handoff 记录。

## 验证

- `apps/agent/test/conversation/queue.test.ts` 新增失败原因回归测试。
- `botSelection.test.ts`、`teamHandoff.test.ts` 交接失败测试通过。
- Agent 全量测试与类型检查作为提交前门禁。
