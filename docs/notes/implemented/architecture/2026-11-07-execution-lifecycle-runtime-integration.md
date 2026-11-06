# Note：Execution 生命周期接入回合运行时

状态：已实施

## 问题

共享 schema 已定义 run/attempt/step 状态和执行事件，但 Conversation 回合只维护消息状态与模型流，导致 `running`、重试等待和终态没有 Execution 领域的事实 writer。继续这样扩展会让 UI 或 HTTP 重试回调推导执行状态。

## 涉及范围

- `packages/shared/src/schema/execution.ts`、`stream.ts`
- `apps/agent/src/execution/`
- `apps/agent/src/conversation/turn/`
- `apps/agent/src/core/model/retryFetch.ts`
- worker/desktop 的 Execution event 通知帧

不包含磁盘/SQLite、Redis、多实例租约、重启恢复或新的 UI 状态。

## 决定

- `packages/shared/src/schema/execution.ts` 是 retry、run 状态和 Execution event envelope 的唯一 schema 来源。
- `MemoryExecutionStore` 是当前进程内实现；它以显式转移表拒绝非法回退，并为每次迁移写入 `AgentEventEnvelope`。
- `executeTurn` 在模型调用前创建并认领 run，进入 `running`；HTTP 重试等待写入 `retry-wait`，等待后递增 attempt 并回到 `running`；模型完成、失败或取消分别写入对应终态。
- 现有 `ConversationEvent.stream.retry` 继续服务 Wi‑Fi UI；它与 Execution event 是同一次重试的两个明确投影，不互相推导状态。
- worker 通过独立 `execution-event` 通知帧传输事件；桌面主进程只转发给订阅者，不把它误当 RPC response。

## 曾考虑的替代方案

- **让 UI 根据 `retry` 或计时器推导 run 状态：** 舍弃。状态没有唯一 writer，无法支持恢复和审计。
- **把 Execution 字段塞进 Conversation message/change：** 舍弃。transcript 与执行生命周期有不同保留、并发和未来持久化边界。
- **本次直接接 Redis/SQLite：** 舍弃。当前没有重启恢复、幂等、租约 fencing 和多租户授权的已验证契约。

## 后果与防回退

- 新增 run/attempt/step 状态只能扩展 shared execution schema，并通过 `ExecutionStore` 写入；禁止从消息文本、UI 图标或时间反推。
- 模型 HTTP 重试只能通过 `RetryAttempt` 回调进入 Execution 和 Conversation 两个明确 writer；供应商状态码不进入共享事件 payload。
- 当前 `MemoryExecutionStore` 随 Agent 进程退出而丢失；网站化前必须实现并验证 durable adapter 的顺序、幂等、恢复和多实例一致性。

## 模块边界

- `packages/shared/src/schema/execution.ts`：唯一执行状态、重试事实和 envelope schema。
- `apps/agent/src/execution/`：状态转移、事件创建、进程内 store 和读投影；不依赖 Electron 或 React。
- `apps/agent/src/core/model/retryFetch.ts`：只决定 HTTP 是否可重放及等待多久，通过回调报告 retry；不写 Execution store。
- `apps/agent/src/conversation/turn/executeTurn.ts`：把模型调用生命周期接到 ExecutionStore 与 ConversationStore。
- `apps/agent/src/worker/` 与 `apps/desktop/src/main/conversation/agentService.ts`：传输和分发 Execution event，不重新定义状态。

## 验证

- `MemoryExecutionStore` 测试覆盖完整状态迁移、终态回退拒绝和事件订阅回放。
- shared、agent、desktop typecheck 通过；Agent 21 个测试文件、143 项测试通过；shared schema 测试通过。
- 全量 `pnpm verify` 与 `pnpm notes:check` 作为提交前门禁执行。
